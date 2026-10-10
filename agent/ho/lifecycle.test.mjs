import test from "node:test";
import assert from "node:assert/strict";
import {
  actionLoopElapsedMs,
  actionLoopExpired,
  beginActionLoop,
  finishActiveSegment,
  finishActionLoop,
  goalDeadlineExpired,
  startActiveSegment,
} from "./lifecycle.mjs";

test("active time is accumulated once and AL budget remains separate from OST deadline", () => {
  const state = {
    createdAt: 1_000,
    goalAttemptStartedAt: 1_000,
    goalDeadlineAt: 1_801_000,
    actionLoop: { index: 1, status: "running", budgetMinutes: 15, elapsedMs: 0, segmentStartedAt: null },
  };
  startActiveSegment(state, 5_000);
  assert.equal(actionLoopElapsedMs(state, 65_000), 60_000);
  assert.equal(actionLoopExpired(state, { now: 65_000 }), false);
  assert.equal(finishActiveSegment(state, 65_000), 60_000);
  assert.equal(finishActiveSegment(state, 70_000), 0);
  assert.equal(state.actionLoop.elapsedMs, 60_000);
  assert.equal(goalDeadlineExpired(state, { now: 1_800_999 }), false);
  assert.equal(goalDeadlineExpired(state, { now: 1_801_000 }), true);
});

test("new AL preserves a bounded history record without changing the OST identity", () => {
  const state = {
    goalId: "ost-1",
    actionLoop: { index: 2, status: "completed-timeout-review", estimatedMinutes: 18, budgetMinutes: 20, strategy: "switch route", endedAt: 99 },
  };
  const next = beginActionLoop(state, "timeout-new-loop", 100);
  assert.equal(next.index, 3);
  assert.equal(next.status, "planning");
  assert.equal(state.goalId, "ost-1");
  assert.deepEqual(state.actionLoopHistory, [{ index: 2, status: "completed-timeout-review", estimatedMinutes: 18,
    budgetMinutes: 20, strategy: "switch route", endedAt: 99, endReason: "timeout-new-loop" }]);
});

test("finishing an AL records its actual end time", () => {
  const state = { actionLoop: { index: 1, status: "running" } };
  assert.equal(finishActionLoop(state, "completed", 500), state.actionLoop);
  assert.equal(state.actionLoop.status, "completed");
  assert.equal(state.actionLoop.endedAt, 500);
});
