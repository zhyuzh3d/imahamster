import test from "node:test";
import assert from "node:assert/strict";
import {
  createLearningJob, createLearningMaintenanceAttempt, isLearningJob, learningJobKey,
} from "./maintenance.mjs";

test("learning completion becomes one deterministic, bounded internal event", () => {
  const source = {
    sourceGoalId: "goal-source-1", sourceTaskId: "task-source-1",
    intent: "完成一个合成用户目标", progress: "LLM 根据最终观察判断完成",
    history: Array.from({ length: 30 }, (_, step) => ({ sourceRef: `goal:source:${step}`,
      at: step, step, phase: "decision", evidence: "x".repeat(500) })), now: 100,
  };
  const first = createLearningJob(source);
  const retry = createLearningJob(source);

  assert.equal(first.key, learningJobKey(source.sourceGoalId));
  assert.equal(first.key, retry.key);
  assert.equal(isLearningJob(first.value), true);
  assert.equal(first.value.history.length, 24);
  assert.equal(first.value.history[0].step, 6);
  assert.equal(first.value.history.at(-1).evidence.length, 240);
  assert.equal(first.value.state, "pending");
});

test("learning maintenance is a separate data-only OST linked to its source event", () => {
  const job = createLearningJob({
    sourceGoalId: "goal-source-2", sourceTaskId: "task-source-2",
    intent: "总结一个合成目标", progress: "完成依据", history: [], now: 1000,
  });
  const attempt = createLearningMaintenanceAttempt(job.value, {
    jobKey: job.key, jobRevision: "host-r3", now: 2000, goalDeadlineMs: 1_800_000,
  });

  assert.equal(attempt.state.taskKind, "OST");
  assert.equal(attempt.state.taskRecordKind, "learning-maintenance");
  assert.equal(attempt.state.state, "active");
  assert.equal(attempt.state.goalDeadlineAt, 1_802_000);
  assert.equal(attempt.state.learningMaintenance.sourceGoalId, job.value.sourceGoalId);
  assert.equal(attempt.state.learningMaintenance.jobRevision, "host-r3");
  assert.equal(attempt.goal.purpose, "learning-maintenance");
  assert.equal(attempt.task.kind, "learning-maintenance");
  assert.deepEqual(attempt.task.resultRefs, [`goal:${job.value.sourceGoalId}:result`]);
  assert.equal(attempt.nextJob.state, "running");
  assert.equal(attempt.nextJob.attempts, 1);
  const retry = createLearningMaintenanceAttempt(attempt.nextJob, {
    jobKey: job.key, jobRevision: "host-r4", now: 3000,
  });
  assert.equal(retry.nextJob.attempts, 2);
  assert.notEqual(retry.state.goalId, attempt.state.goalId,
    "a later maintenance attempt must not collide with the prior OST record");
});

test("malformed learning events and missing revisions cannot start maintenance OSTs", () => {
  assert.equal(isLearningJob({ schemaVersion: 1, type: "learning.maintenance", state: "running",
    sourceGoalId: "goal", sourceTaskId: "task", intent: "目标", progress: "结果", history: [], attempts: 0 }), true);
  assert.equal(isLearningJob({ schemaVersion: 1, type: "learning.maintenance", state: "done",
    sourceGoalId: "goal", sourceTaskId: "task", intent: "目标", progress: "结果", history: [] }), false);
  assert.throws(() => createLearningJob({ sourceGoalId: "", sourceTaskId: "t", intent: "目标", progress: "结果" }));
  const job = createLearningJob({ sourceGoalId: "goal", sourceTaskId: "task", intent: "目标", progress: "结果" });
  assert.throws(() => createLearningMaintenanceAttempt(job.value, { jobKey: job.key, jobRevision: "" }));
});
