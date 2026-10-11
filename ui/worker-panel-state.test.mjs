import test from "node:test";
import assert from "node:assert/strict";
import { deriveWorkerPanelState } from "./worker-panel-state.mjs";

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
