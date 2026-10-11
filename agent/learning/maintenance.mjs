import { eventReceiptKey } from "../ho/events.mjs";

export const LEARNING_JOB_PREFIX = "l:";

function boundedText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-24).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof item.sourceRef !== "string" || !item.sourceRef) return [];
    return [{
      sourceRef: item.sourceRef.slice(0, 240),
      at: Number.isFinite(Number(item.at)) ? Number(item.at) : 0,
      step: Number.isSafeInteger(Number(item.step)) ? Number(item.step) : 0,
      phase: boundedText(item.phase, 64),
      ...(item.decision ? { decision: boundedText(item.decision, 48) } : {}),
      ...(item.actionType ? { actionType: boundedText(item.actionType, 48) } : {}),
      ...(item.target ? { target: boundedText(item.target, 120) } : {}),
      ...(item.label ? { label: boundedText(item.label, 80) } : {}),
      ...(item.evidence ? { evidence: boundedText(item.evidence, 240) } : {}),
      ...(item.issue ? { issue: boundedText(item.issue, 180) } : {}),
      ...(item.code ? { code: boundedText(item.code, 48) } : {}),
      ...(item.choice ? { choice: boundedText(item.choice, 48) } : {}),
      ...(item.recovery ? { recovery: boundedText(item.recovery, 48) } : {}),
      ...(item.operationResult ? { operationResult: boundedText(item.operationResult, 48) } : {}),
    }];
  });
}

export function learningJobKey(sourceGoalId) {
  const id = boundedText(sourceGoalId, 160);
  if (!id) throw new TypeError("A source Goal ID is required for learning maintenance");
  return `${LEARNING_JOB_PREFIX}${eventReceiptKey(`learning-maintenance:${id}`).slice("event:".length)}`;
}

/** Durable internal completion event. The event contains only bounded, source-linked learning context. */
export function createLearningJob({ sourceGoalId, sourceTaskId, intent, progress, history, now = Date.now() } = {}) {
  const id = boundedText(sourceGoalId, 160);
  const taskId = boundedText(sourceTaskId, 160);
  const sourceIntent = boundedText(intent, 1200);
  const sourceProgress = boundedText(progress, 800);
  if (!id || !taskId || !sourceIntent || !sourceProgress) {
    throw new TypeError("Learning maintenance requires a completed source Goal, Task, intent, and result");
  }
  return {
    key: learningJobKey(id),
    value: {
      schemaVersion: 1,
      type: "learning.maintenance",
      state: "pending",
      sourceGoalId: id,
      sourceTaskId: taskId,
      intent: sourceIntent,
      progress: sourceProgress,
      history: normalizeHistory(history),
      attempts: 0,
      createdAt: Number(now) || Date.now(),
    },
  };
}

export function isLearningJob(value) {
  return value?.schemaVersion === 1 && value?.type === "learning.maintenance" &&
    ["pending", "running"].includes(value.state) && typeof value.sourceGoalId === "string" &&
    value.sourceGoalId.length > 0 && value.sourceGoalId.length <= 160 &&
    typeof value.sourceTaskId === "string" && value.sourceTaskId.length > 0 && value.sourceTaskId.length <= 160 &&
    typeof value.intent === "string" && value.intent.trim().length > 0 && value.intent.length <= 1200 &&
    typeof value.progress === "string" && value.progress.trim().length > 0 && value.progress.length <= 800 &&
    Array.isArray(value.history) && value.history.length <= 24 &&
    Number.isSafeInteger(Number(value.attempts)) && Number(value.attempts) >= 0;
}

/** Build one independent, data-only maintenance OST attempt from a durable event. */
export function createLearningMaintenanceAttempt(job, {
  jobKey, jobRevision, now = Date.now(), goalDeadlineMs = 30 * 60_000,
} = {}) {
  if (!isLearningJob(job) || typeof jobKey !== "string" || jobKey !== learningJobKey(job.sourceGoalId) ||
      typeof jobRevision !== "string" || !jobRevision) {
    throw new TypeError("A revisioned learning event is required");
  }
  const attempts = Math.max(0, Math.floor(Number(job.attempts) || 0)) + 1;
  const sourceHash = jobKey.slice(LEARNING_JOB_PREFIX.length);
  const goalId = `learning-${sourceHash}-${attempts}`;
  const taskId = `learning-task-${sourceHash}-${attempts}`;
  const intent = "整理已完成任务的可复用记忆、行为模式与工具经验";
  const taskObjective = "只读取来源记录并判断是否需要保存 Memory、BP 或工具配方";
  const runId = `${Number(now).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const state = {
    schemaVersion: 1,
    goalId, taskId, runId, intent, taskObjective,
    taskType: "one-shot", taskKind: "OST", taskRecordKind: "learning-maintenance",
    state: "active", step: 0, revision: 1, createdAt: now,
    goalAttemptStartedAt: now, goalDeadlineAt: now + Math.max(1000, Number(goalDeadlineMs) || 30 * 60_000),
    progress: "开始整理已完成 OST 的记录；此维护任务不操作目标应用。",
    learningStatus: "running",
    learningMaintenance: {
      sourceGoalId: job.sourceGoalId,
      sourceTaskId: job.sourceTaskId,
      sourceIntent: job.intent,
      sourceProgress: job.progress,
      sourceHistory: normalizeHistory(job.history),
      jobKey, jobRevision, attempt: attempts,
    },
    goalPlan: { scope: { sourceGoalId: job.sourceGoalId }, triggers: [],
      completion: "由 LLM 根据来源轨迹决定是否有可复用学习结果", priority: -1, acceptedBoundary: "system" },
    taskPlan: { dependencies: [], objectKey: null },
    trace: [], journalSequence: 0,
    activeElapsedMs: 0, activeSegmentStartedAt: now,
    recoveryAttempts: 0, pendingOperations: [],
  };
  const goal = {
    schemaVersion: 1, goalId, intent, taskKind: "OST", purpose: "learning-maintenance",
    sourceGoalId: job.sourceGoalId, scope: { sourceGoalId: job.sourceGoalId }, triggers: [],
    completion: state.goalPlan.completion, priority: -1, acceptedBoundary: "system",
    state: "active", revision: 1, progress: state.progress, createdAt: now, updatedAt: now,
  };
  const task = {
    schemaVersion: 1, taskId, goalId, runId, kind: "learning-maintenance", state: "running",
    objective: taskObjective, dependencies: [], objectKey: null, progress: state.progress,
    waiting: null, resultRefs: [`goal:${job.sourceGoalId}:result`], revision: 1,
    createdAt: now, updatedAt: now,
  };
  const nextJob = { ...job, state: "running", attempts, maintenanceGoalId: goalId,
    maintenanceTaskId: taskId, startedAt: now };
  return { state, goal, task, nextJob };
}
