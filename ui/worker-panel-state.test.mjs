import test from "node:test";
import assert from "node:assert/strict";
import { deriveWorkerPanelState, matchesPersistedGoal, reconcileLastResultWithGoal } from "./worker-panel-state.mjs";

test("resumed goal identity survives a later retry timestamp and same-text goals remain distinct", () => {
  const lastResult = { status: "running", goalIntent: "执行合成目标", goalId: "g-current", acceptedAt: 1000 };
  assert.equal(matchesPersistedGoal({ goalId: "g-current", intent: "执行合成目标", createdAt: 1000 }, lastResult), true);
  assert.equal(matchesPersistedGoal({ goalId: "g-next", intent: "执行合成目标", createdAt: 2000 }, lastResult), false);
});

test("a terminal source goal reconciles a stale running result after learning maintenance", () => {
  const result = reconcileLastResultWithGoal({ status: "running", goalIntent: "执行合成目标", acceptedAt: 2000 }, {
    value: { goalId: "g-source", intent: "执行合成目标", state: "done", progress: "LLM 判定目标完成", updatedAt: 3000 },
  });
  assert.deepEqual(result, { status: "done", goalIntent: "执行合成目标", acceptedAt: 2000,
    goalId: "g-source", summary: "LLM 判定目标完成", finishedAt: 3000 });
  assert.equal(reconcileLastResultWithGoal({ status: "running", goalIntent: "另一个目标" }, {
    value: { goalId: "g-source", intent: "执行合成目标", state: "done" },
  }), null);
});

test("a failed host handoff without an active-goal record stays visible and retryable", () => {
  const state = deriveWorkerPanelState({
    activeRecord: null,
    serviceState: "failed",
    lastResult: { status: "running", goalIntent: "执行合成目标", acceptedAt: 1000 },
  });

  assert.equal(state.visible, true);
  assert.equal(state.interruptedHandoff, true);
  assert.equal(state.orphanedHandoff, true);
  assert.equal(state.resumeEnabled, true);
});

test("a persisted active goal keeps the existing failed-worker resume path", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "waiting", intent: "执行合成目标", createdAt: 1000 } },
    serviceState: "failed",
    lastResult: { status: "running", goalIntent: "执行合成目标", acceptedAt: 1000 },
  });

  assert.equal(state.interruptedHandoff, true);
  assert.equal(state.orphanedHandoff, false);
  assert.equal(state.resumeEnabled, true);
});

test("a failed worker without a submitted goal does not expose a phantom retry", () => {
  const state = deriveWorkerPanelState({ activeRecord: null, serviceState: "failed", lastResult: null });

  assert.equal(state.visible, false);
  assert.equal(state.interruptedHandoff, false);
  assert.equal(state.resumeEnabled, false);
});

test("a prior terminal goal cannot hide a newer handoff that failed before persistence", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", intent: "上一个目标", createdAt: 900 } },
    serviceState: "failed",
    lastResult: { status: "running", goalIntent: "新目标", acceptedAt: 1000 },
  });

  assert.equal(state.visible, true);
  assert.equal(state.persistedCurrentGoal, false);
  assert.equal(state.orphanedHandoff, true);
  assert.equal(state.resumeEnabled, true);
});

test("a completed OST exposes a separate retry control when background queue recovery is exhausted", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", trace: [], postTaskQueueRecovery: {
      kind: "inbox-drain", state: "needs-user", attempts: 8, userRequired: true,
    } } },
    serviceState: "running",
  });

  assert.equal(state.visible, true);
  assert.equal(state.activeCanControl, false, "queue recovery must not reopen the completed OST");
  assert.equal(state.queueRecoveryNeedsUser, true);
  assert.equal(state.resumeEnabled, true);
});

test("completed OST exposes pending and failed learning maintenance status", () => {
  const pending = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", learningStatus: "pending", trace: [] } },
    serviceState: "running",
  });
  assert.equal(pending.visible, true);
  assert.equal(pending.learningStatus, "成功后经验整理待完成");

  const failed = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", learningStatus: "skipped", learningError: "模型服务超时", trace: [] } },
    serviceState: "running",
  });
  assert.equal(failed.visible, true);
  assert.equal(failed.learningStatus, "成功后经验整理未完成：模型服务超时");
});

test("completed OST summarizes successful learning without changing its task state", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", learningStatus: "complete", learningSaved: 3, trace: [] } },
    serviceState: "running",
  });
  assert.equal(state.visible, true);
  assert.equal(state.activeCanControl, false);
  assert.equal(state.learningStatus, "成功后经验整理完成，保存 3 条");
});

test("separate learning maintenance OST reports its own progress and completion", () => {
  const running = deriveWorkerPanelState({
    activeRecord: { value: { state: "active", learningStatus: "running", learningMaintenance: { sourceGoalId: "g-source" } } },
    serviceState: "running",
  });
  assert.equal(running.learningStatus, "后台经验整理进行中");

  const completed = deriveWorkerPanelState({
    activeRecord: { value: { state: "done", learningStatus: "complete", learningSaved: 2,
      learningMaintenance: { sourceGoalId: "g-source" } } },
    serviceState: "running",
  });
  assert.equal(completed.learningStatus, "后台经验整理完成，保存 2 条");
});

test("decomposed OST progress identifies the current HO Task and completed units", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "active", taskId: "t2", taskGraph: { tasks: [
      { taskId: "t1", objective: "读取新消息", state: "done", planIndex: 0 },
      { taskId: "t2", objective: "拟定并核对回复", state: "running", planIndex: 1 },
      { taskId: "t3", objective: "记录结果", state: "ready", planIndex: 2 },
    ] } } },
    serviceState: "running",
  });

  assert.deepEqual(state.taskGraphProgress, {
    completed: 1, total: 3, currentLabel: "第 2/3 项：拟定并核对回复",
  });
});

test("whole-goal review is shown separately from the completed child Tasks", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "active", taskId: "tc", taskReviewMode: true,
      taskGraph: { coordinatorTaskId: "tc", tasks: [
        { taskId: "t1", objective: "第一项", state: "done" },
        { taskId: "t2", objective: "第二项", state: "done" },
      ] } } },
    serviceState: "running",
  });

  assert.deepEqual(state.taskGraphProgress, {
    completed: 2, total: 2, currentLabel: "整体目标复核",
  });
});

test("a durable task-done decision shows a scheduler handoff instead of a running child", () => {
  const state = deriveWorkerPanelState({
    activeRecord: { value: { state: "active", taskId: "t1", lastDecision: { state: "task-done" },
      taskGraph: { tasks: [
        { taskId: "t1", objective: "读取最新消息", state: "done", planIndex: 0 },
        { taskId: "t2", objective: "拟定回复", state: "ready", planIndex: 1 },
      ] } } },
    serviceState: "running",
  });

  assert.deepEqual(state.taskGraphProgress, {
    completed: 1, total: 2, currentLabel: "当前项已完成，等待 HO 调度下一项",
  });
});
