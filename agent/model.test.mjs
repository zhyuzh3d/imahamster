import test from "node:test";
import assert from "node:assert/strict";
import { AgentCollections, AgentStore } from "./store.mjs";
import { assertAcyclicTasks } from "./model.mjs";

function fakeData() {
  const records = new Map();
  let sequence = 0;
  const identity = (collection, key) => `${collection}\u0000${key}`;
  const check = (current, expected) => {
    if (expected === undefined) return;
    if (expected === "absent" && current) throw Object.assign(new Error("conflict"), { code: "E_CONFLICT" });
    if (expected !== "absent" && current?.revision !== expected) {
      throw Object.assign(new Error("conflict"), { code: "E_CONFLICT" });
    }
  };
  const put = (collection, key, value, expectedRevision) => {
    const current = records.get(identity(collection, key));
    check(current, expectedRevision);
    const revision = `generation:${++sequence}`;
    records.set(identity(collection, key), { collection, key, value: structuredClone(value), revision });
    return { collection, key, revision };
  };
  return {
    async get({ collection, key }) {
      const item = records.get(identity(collection, key));
      return item ? structuredClone(item) : null;
    },
    async put({ collection, key, value, expectedRevision }) {
      return put(collection, key, value, expectedRevision);
    },
    async scan({ collection, prefix = "", afterKey, limit = 100 }) {
      const all = [...records.values()].filter((item) => item.collection === collection && item.key.startsWith(prefix))
        .sort((a, b) => a.key.localeCompare(b.key));
      const remaining = all.filter((item) => !afterKey || item.key > afterKey);
      const items = remaining.slice(0, Math.min(limit, 100));
      return { items: structuredClone(items), nextAfterKey: remaining.length > items.length ? items.at(-1).key : null };
    },
    async batch({ operations }) {
      const seen = new Set();
      for (const operation of operations) {
        const id = identity(operation.collection, operation.key);
        if (seen.has(id)) throw new TypeError("duplicate key");
        seen.add(id);
        check(records.get(id), operation.expectedRevision);
      }
      return { results: operations.map((operation) => put(operation.collection, operation.key,
        operation.value, operation.expectedRevision)) };
    },
  };
}

test("Goal and Task revisions persist through legal state transitions", async () => {
  let now = 100;
  let id = 0;
  const data = fakeData();
  const store = new AgentStore(data, { now: () => now++, id: () => `id-${++id}` });
  const goal = await store.createGoal("处理指定会话的新消息", { goalId: "goal-1" });
  const task = await store.createTask(goal.goalId, { taskId: "task-1", objective: "核实最新消息" });

  const running = await store.transitionTask(task.taskId, "running", { progress: "已读取会话" });
  assert.equal(running.value.revision, 2);
  const done = await store.transitionTask(task.taskId, "done", { progress: "已核实处理结果" });
  assert.equal(done.value.state, "done");
  await assert.rejects(() => store.transitionTask(task.taskId, "ready"), /Invalid Task transition/);
  const persisted = await data.get({ collection: AgentCollections.TASKS, key: "t:task-1" });
  assert.equal(persisted.value.progress, "已核实处理结果");
});

test("event receipt is idempotent under duplicate delivery", async () => {
  const store = new AgentStore(fakeData(), { now: () => 200, id: () => "unused" });
  const first = await store.receiveEvent({ eventId: "notification-42", source: "notification" });
  const second = await store.receiveEvent({ eventId: "notification-42", source: "notification-update" });
  assert.equal(first.received, true);
  assert.equal(second.received, false);
  assert.equal(second.existing.value.source, "notification");
});

test("effect intent and Task state commit before one externally visible action", async () => {
  let id = 0;
  const data = fakeData();
  const store = new AgentStore(data, { id: () => `op-${++id}` });
  const goal = await store.createGoal("按范围回复新消息", { goalId: "goal-3" });
  const task = await store.createTask(goal.goalId, { taskId: "task-3", objectKey: "wx:account-1:chat-1" });
  await store.transitionTask(task.taskId, "running");
  const action = {
    tool: "interaction.tap",
    intent: "send-reply",
    args: { target: "visible send button" },
    effectKey: { intent: "send-reply", contentAnchor: "reply-17" },
  };
  const identity = { accountKey: "wechat-account-1", objectKey: "chat-1" };
  const prepared = await store.prepareOperation(task.taskId, action, identity);
  assert.equal((await data.get({ collection: AgentCollections.OPERATIONS, key: `o:${prepared.operationId}` })).value.status, "prepared");
  assert.equal((await data.get({ collection: AgentCollections.TASKS, key: "t:task-3" })).value.pendingOperationId, prepared.operationId);
  await assert.rejects(() => store.prepareOperation(task.taskId, action, identity), /Task is not ready/);

  await store.updateOperation(prepared.operationId, "accepted", { receipt: { state: "accepted" } });
  const verified = await store.updateOperation(prepared.operationId, "verified", { evidenceRefs: ["frame-1"] });
  assert.equal(verified.status, "verified");
  assert.equal((await data.get({ collection: AgentCollections.TASKS, key: "t:task-3" })).value.pendingOperationId, null);
  await assert.rejects(() => store.prepareOperation(task.taskId, action, identity), /already reserved/);
});

test("task dependencies reject missing records and cycles", async () => {
  let id = 0;
  const store = new AgentStore(fakeData(), { id: () => `id-${++id}` });
  const goal = await store.createGoal("整理订阅内容", { goalId: "goal-2" });
  await assert.rejects(() => store.createTask(goal.goalId, { taskId: "child", dependencies: ["missing"] }), /dependency is missing/);
  assert.throws(() => assertAcyclicTasks([
    { taskId: "a", dependencies: ["b"] },
    { taskId: "b", dependencies: ["a"] },
  ]), /cycle/);
});

test("scheduler and dispatch honor Goal state and dependency completion", async () => {
  const data = fakeData();
  const store = new AgentStore(data, { id: (() => { let id = 0; return () => `scheduled-${++id}`; })() });
  const goal = await store.createGoal("整理指定资料", { goalId: "goal-schedule" });
  const first = await store.createTask(goal.goalId, { taskId: "first" });
  const second = await store.createTask(goal.goalId, { taskId: "second", dependencies: [first.taskId] });
  const third = await store.createTask(goal.goalId, { taskId: "third" });
  let ready = await store.listReadyTasks();
  assert.deepEqual(ready.items.map((record) => record.value.taskId), [first.taskId, third.taskId]);
  await assert.rejects(() => store.transitionTask(second.taskId, "running"), /dependency is not complete/);

  await store.transitionTask(first.taskId, "running");
  await store.transitionTask(first.taskId, "done");
  ready = await store.listReadyTasks();
  assert.deepEqual(ready.items.map((record) => record.value.taskId), [second.taskId, third.taskId]);

  await store.transitionTask(third.taskId, "running");
  await store.setGoalState(goal.goalId, "paused");
  await assert.rejects(() => store.transitionTask(second.taskId, "running"), /Goal is inactive/);
  await store.setGoalState(goal.goalId, "active");
  await store.transitionTask(second.taskId, "running");
  const prepared = await store.prepareOperation(second.taskId, { tool: "interaction.tap", intent: "advance" });
  await store.setGoalState(goal.goalId, "paused");
  await assert.rejects(() => store.prepareOperation(third.taskId, { tool: "interaction.tap", intent: "advance" }), /Goal is inactive/);
  await store.updateOperation(prepared.operationId, "accepted");
  const failed = await store.updateOperation(prepared.operationId, "failed", { failure: "test receipt" });
  assert.equal(failed.status, "failed");
});

test("Goal completion requires all Tasks done and persisted evidence", async () => {
  const store = new AgentStore(fakeData(), { id: (() => { let id = 0; return () => `complete-${++id}`; })() });
  const goal = await store.createGoal("整理一篇指定文章", { goalId: "goal-complete" });
  await assert.rejects(() => store.completeGoal(goal.goalId, { summary: "已整理", evidenceRefs: ["file:result"] }), /before it has Tasks/);
  const task = await store.createTask(goal.goalId);
  await assert.rejects(() => store.completeGoal(goal.goalId, { summary: "已整理", evidenceRefs: ["file:result"] }), /unfinished Tasks/);
  await store.transitionTask(task.taskId, "running");
  await store.transitionTask(task.taskId, "done");
  const completed = await store.completeGoal(goal.goalId, { summary: "已保存文章摘要", evidenceRefs: ["file:summary"] });
  assert.equal(completed.value.state, "done");
  assert.deepEqual(completed.value.evidenceRefs, ["file:summary"]);
  await assert.rejects(() => store.createTask(goal.goalId), /active Goal/);

  const recurring = await store.createGoal("每日整理订阅号", { goalId: "goal-recurring", triggers: [{ type: "daily" }] });
  await store.createTask(recurring.goalId);
  await assert.rejects(() => store.completeGoal(recurring.goalId, { summary: "已整理", evidenceRefs: ["file:daily"] }), /recurring Goal/);
});
