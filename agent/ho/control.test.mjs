import test from "node:test";
import assert from "node:assert/strict";
import { prepareUserControlTransition, shouldFenceWorkerForEventTaskControl } from "./control.mjs";

function activeRecords(state = "active", overrides = {}) {
  return {
    activeRecord: { value: { goalId: "g1", taskId: "t1", intent: "完成合成目标", state,
      revision: 2, waiting: { reason: "等待用户" }, ...overrides }, revision: 8 },
    goalRecord: { value: { goalId: "g1", state, revision: 4 }, revision: 12 },
    taskRecord: { value: { taskId: "t1", state: "running", revision: 5 }, revision: 20 },
  };
}

test("pause prepares one optimistic HO transition for OST, Goal, Task, and journal", () => {
  const result = prepareUserControlTransition({ ...activeRecords(), command: "pause", now: 1000 });
  assert.equal(result.updated, true);
  assert.equal(result.nextActive.state, "paused");
  assert.equal(result.operations[0].expectedRevision, 8);
  assert.equal(result.operations[0].value.revision, 3);
  assert.equal(result.operations[1].collection, "agent-events");
  assert.equal(result.operations[1].value.phase, "user-control.pause");
  assert.equal(result.operations[1].value.source, "user");
  assert.equal(result.operations[2].expectedRevision, 12);
  assert.equal(result.operations[2].value.state, "paused");
  assert.equal(result.operations[3].expectedRevision, 20);
  assert.equal(result.operations[3].value.state, "paused");
  assert.equal(result.operations[3].value.waiting.since, 1000);
});

test("cancel records the queue purge count while leaving queue IO to the Worker", () => {
  const result = prepareUserControlTransition({ ...activeRecords(), command: "cancel", queuedCancelled: 105, now: 2000 });
  assert.equal(result.updated, true);
  assert.equal(result.queuedCancelled, 105);
  assert.equal(result.nextActive.state, "cancelled");
  assert.equal(result.operations.some(operation => operation.collection === "inbox"), false);
});

test("resume clears waiting and applies the user's continuation through HO", () => {
  const result = prepareUserControlTransition({ ...activeRecords("paused", { recoveryAttempts: 7 }),
    command: "resume", reply: "只检查会话标题", now: 3000 });
  assert.equal(result.updated, true);
  assert.equal(result.intent, "完成合成目标；用户补充：只检查会话标题");
  assert.equal(result.nextActive.state, "active");
  assert.equal(result.nextActive.waiting, null);
  assert.equal(result.nextActive.recoveryAttempts, 0);
  assert.equal(result.operations[3].value.state, "ready");
});

test("manual retry after the OST hard deadline starts a fresh bounded attempt", () => {
  const result = prepareUserControlTransition({ ...activeRecords("failed", {
    recoveryAttempts: 12,
    goalAttemptStartedAt: 1000,
    goalDeadlineAt: 1_801_000,
    attempt: 1,
    waiting: { category: "goal-time-limit", reason: "超过 30 分钟" },
  }), command: "resume", now: 2_000_000, random: () => 0.5 });
  assert.equal(result.nextActive.goalAttemptStartedAt, 2_000_000);
  assert.equal(result.nextActive.goalDeadlineAt, 3_800_000);
  assert.equal(result.nextActive.attempt, 2);
  assert.equal(result.nextActive.recoveryAttempts, 0);
  assert.equal(result.operations[1].value.retryAfterGoalTimeLimit, true);
});

test("terminal goals and already-paused goals are no-op transitions", () => {
  assert.equal(prepareUserControlTransition({ ...activeRecords("done"), command: "cancel" }).updated, false);
  assert.equal(prepareUserControlTransition({ ...activeRecords("paused"), command: "pause" }).updated, false);
});

test("EDT pause and cancel fence only the matching active triggered OST before queueing control", () => {
  const child = { state: "active", taskKind: "OST", parentEventTaskId: "edt-1" };
  assert.equal(shouldFenceWorkerForEventTaskControl(child, "edt-1", "pause"), true);
  assert.equal(shouldFenceWorkerForEventTaskControl(child, "edt-1", "cancel"), true);
  assert.equal(shouldFenceWorkerForEventTaskControl(child, "edt-1", "resume"), false,
    "resuming future triggers must not interrupt the current OST");
  assert.equal(shouldFenceWorkerForEventTaskControl(child, "edt-2", "cancel"), false);
  assert.equal(shouldFenceWorkerForEventTaskControl({ ...child, state: "done" }, "edt-1", "cancel"), false);
  assert.equal(shouldFenceWorkerForEventTaskControl({ state: "event-driven", eventTaskId: "edt-1" }, "edt-1", "pause"), true);
});
