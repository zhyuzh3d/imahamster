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

test("pause and resume keep the current decomposed Task aligned with HO state", () => {
  const children = [
    { taskId: "t1", goalId: "g1", runId: "r1", objective: "第一项", state: "running", dependencies: [], revision: 2 },
    { taskId: "t2", goalId: "g1", runId: "r2", objective: "第二项", state: "ready", dependencies: ["t1"], revision: 1 },
  ];
  const active = activeRecords("active", { taskGraph: {
    coordinatorTaskId: "tc", coordinatorRunId: "rc", coordinatorRevision: 3, tasks: children,
  } });
  const paused = prepareUserControlTransition({ ...active, command: "pause", now: 1000 });
  assert.deepEqual(paused.nextActive.taskGraph.tasks.map(item => item.state), ["paused", "ready"]);
  assert.equal(paused.operations.find(item => item.collection === "tasks" && item.key === "t:t1").value.state, "paused");
  const resumed = prepareUserControlTransition({ ...activeRecords("paused", {
    ...active.activeRecord.value, state: "paused", taskGraph: paused.nextActive.taskGraph,
  }), command: "resume", now: 2000 });
  assert.deepEqual(resumed.nextActive.taskGraph.tasks.map(item => item.state), ["ready", "ready"]);
  assert.equal(resumed.operations.find(item => item.collection === "tasks" && item.key === "t:t1").value.state, "ready");
});

test("cancel marks unfinished child Tasks and the coordinator cancelled atomically", () => {
  const active = activeRecords("active", { taskGraph: {
    coordinatorTaskId: "tc", coordinatorRunId: "rc", coordinatorRevision: 3,
    tasks: [
      { taskId: "t1", goalId: "g1", runId: "r1", objective: "第一项", state: "running", dependencies: [], revision: 2 },
      { taskId: "t2", goalId: "g1", runId: "r2", objective: "第二项", state: "ready", dependencies: ["t1"], revision: 1 },
      { taskId: "t3", goalId: "g1", runId: "r3", objective: "已完成项", state: "done", dependencies: [], revision: 2 },
    ],
  } });
  const cancelled = prepareUserControlTransition({ ...active, command: "cancel", now: 3000 });
  assert.deepEqual(cancelled.nextActive.taskGraph.tasks.map(item => item.state), ["cancelled", "cancelled", "done"]);
  assert.equal(cancelled.nextActive.taskGraph.coordinatorRevision, 4);
  assert.equal(cancelled.operations.find(item => item.collection === "tasks" && item.key === "t:t2").value.state, "cancelled");
  assert.equal(cancelled.operations.find(item => item.collection === "tasks" && item.key === "t:tc").value.state, "cancelled");
});

test("user control does not rewrite a child already completed before its scheduler handoff", () => {
  const base = activeRecords("active", { taskGraph: {
    coordinatorTaskId: "tc", coordinatorRunId: "rc", coordinatorRevision: 3,
    tasks: [{ taskId: "t1", goalId: "g1", runId: "r1", objective: "第一项", state: "done",
      dependencies: [], revision: 2, progress: "模型已完成当前单元" }],
  } });
  base.activeRecord.value.lastDecision = { state: "task-done", evidence: "模型已完成当前单元" };
  base.taskRecord.value.state = "done";
  const paused = prepareUserControlTransition({ ...base, command: "pause", now: 4000 });
  assert.equal(paused.nextActive.taskGraph.tasks[0].state, "done");
  assert.equal(paused.operations.some(item => item.collection === "tasks" && item.key === "t:t1"), false);
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
