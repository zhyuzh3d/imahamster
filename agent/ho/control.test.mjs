import test from "node:test";
import assert from "node:assert/strict";
import { applyUserControl } from "./control.mjs";

class MemoryData {
  constructor(entries = []) {
    this.records = new Map(entries.map(([collection, key, value, revision = 1]) =>
      [`${collection}:${key}`, { value: structuredClone(value), revision }]));
  }

  async get({ collection, key }) {
    const item = this.records.get(`${collection}:${key}`);
    return item ? structuredClone(item) : null;
  }

  async scan({ collection, prefix, limit, afterKey }) {
    const items = [...this.records.entries()]
      .filter(([compound]) => compound.startsWith(`${collection}:`))
      .map(([compound, item]) => ({ key: compound.slice(collection.length + 1), ...structuredClone(item) }))
      .filter((item) => item.key.startsWith(prefix) && (!afterKey || item.key > afterKey))
      .sort((a, b) => a.key.localeCompare(b.key))
      .slice(0, limit);
    return { items };
  }

  async batch({ operations }) {
    for (const operation of operations) {
      const compound = `${operation.collection}:${operation.key}`;
      const current = this.records.get(compound);
      if ((operation.expectedRevision === "absent" && current) ||
          (operation.expectedRevision !== undefined && operation.expectedRevision !== "absent" && current?.revision !== operation.expectedRevision)) {
        throw new Error(`revision conflict: ${compound}`);
      }
    }
    for (const operation of operations) {
      const compound = `${operation.collection}:${operation.key}`;
      if (operation.op === "delete") this.records.delete(compound);
      else this.records.set(compound, { value: structuredClone(operation.value), revision: (this.records.get(compound)?.revision || 0) + 1 });
    }
    return { ok: true };
  }
}

function activeRecords(state = "active", overrides = {}) {
  return [
    ["agent-runtime", "active-goal", { goalId: "g1", taskId: "t1", intent: "完成合成目标", state, revision: 2, waiting: { reason: "等待用户" }, ...overrides }, 8],
    ["goals", "g:g1", { goalId: "g1", state, revision: 4 }, 12],
    ["tasks", "t:t1", { taskId: "t1", state: "running", revision: 5 }, 20],
  ];
}

test("pause applies one lifecycle transition to OST, Goal, and Task records", async () => {
  const data = new MemoryData(activeRecords());
  const result = await applyUserControl(data, { command: "pause", now: 1000 });
  assert.equal(result.updated, true);
  assert.equal((await data.get({ collection: "agent-runtime", key: "active-goal" })).value.state, "paused");
  assert.equal((await data.get({ collection: "goals", key: "g:g1" })).value.state, "paused");
  const task = (await data.get({ collection: "tasks", key: "t:t1" })).value;
  assert.equal(task.state, "paused");
  assert.equal(task.waiting.since, 1000);
  const event = await data.get({ collection: "agent-events", key: "e:g1:0000000001" });
  assert.equal(event.value.phase, "user-control.pause");
  assert.equal(event.value.source, "user");
});

test("cancel updates the active OST and removes every queued event across pages", async () => {
  const queued = Array.from({ length: 105 }, (_, index) => ["inbox", `q:${String(index).padStart(3, "0")}`,
    { type: "goal.submit", state: "queued" }]);
  const data = new MemoryData([...activeRecords(), ...queued]);
  const result = await applyUserControl(data, { command: "cancel", now: 2000 });
  assert.equal(result.updated, true);
  assert.equal(result.queuedCancelled, 105);
  assert.equal((await data.get({ collection: "agent-runtime", key: "active-goal" })).value.state, "cancelled");
  assert.equal((await data.get({ collection: "tasks", key: "t:t1" })).value.state, "cancelled");
  assert.equal((await data.scan({ collection: "inbox", prefix: "q:", limit: 200 })).items.length, 0);
});

test("resume transition clears waiting state and records the user's continuation through HO", async () => {
  const data = new MemoryData(activeRecords("paused", { recoveryAttempts: 7 }));
  const result = await applyUserControl(data, { command: "resume", reply: "只检查会话标题", now: 3000 });
  assert.equal(result.updated, true);
  assert.equal(result.intent, "完成合成目标；用户补充：只检查会话标题");
  const active = (await data.get({ collection: "agent-runtime", key: "active-goal" })).value;
  assert.equal(active.state, "active");
  assert.equal(active.waiting, null);
  assert.equal(active.recoveryAttempts, 0);
  assert.equal((await data.get({ collection: "tasks", key: "t:t1" })).value.state, "ready");
});

test("manual retry after the OST hard deadline starts a fresh bounded attempt", async () => {
  const data = new MemoryData(activeRecords("failed", {
    recoveryAttempts: 12,
    goalAttemptStartedAt: 1000,
    goalDeadlineAt: 1_801_000,
    attempt: 1,
    waiting: { category: "goal-time-limit", reason: "超过 30 分钟" },
  }));
  await applyUserControl(data, { command: "resume", now: 2_000_000 });
  const active = (await data.get({ collection: "agent-runtime", key: "active-goal" })).value;
  assert.equal(active.state, "active");
  assert.equal(active.goalAttemptStartedAt, 2_000_000);
  assert.equal(active.goalDeadlineAt, 3_800_000);
  assert.equal(active.attempt, 2);
  assert.equal(active.recoveryAttempts, 0);
  assert.equal((await data.get({ collection: "agent-events", key: "e:g1:0000000001" })).value.retryAfterGoalTimeLimit, true);
});
