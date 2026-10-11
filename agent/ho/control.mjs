import { makeJournalEntry } from "../observability/journal.mjs";

const ACTIVE_COLLECTION = "agent-runtime";
const ACTIVE_KEY = "active-goal";

const CONTROL = Object.freeze({
  pause: { state: "paused", taskState: "paused" },
  resume: { state: "active", taskState: "ready" },
  cancel: { state: "cancelled", taskState: "cancelled" },
});

function isTerminal(state) {
  return ["done", "cancelled"].includes(state);
}

export function shouldFenceWorkerForEventTaskControl(active, eventTaskId, command) {
  const id = String(eventTaskId || "");
  if (!active || !id) return false;
  if (active.state === "event-driven" && active.eventTaskId === id) return true;
  return ["pause", "cancel"].includes(command) && active.parentEventTaskId === id &&
    !["done", "failed", "cancelled"].includes(active.state);
}

function put(collection, key, value, expectedRevision) {
  return { op: "put", collection, key, value, expectedRevision };
}

export function prepareUserControlTransition({ activeRecord, goalRecord, taskRecord,
  command, reply = "", queuedCancelled = 0, now = Date.now(), random = Math.random } = {}) {
  const control = CONTROL[command];
  if (!control) throw new TypeError(`Unsupported user control: ${command}`);
  const value = activeRecord?.value;
  if (!value?.goalId || !value?.taskId || isTerminal(value.state) ||
      (command === "resume" && !["paused", "waiting", "failed"].includes(value.state)) ||
      (command === "pause" && value.state === "paused")) {
    return { updated: false, queuedCancelled, intent: value?.intent || "", operations: [] };
  }

  const progress = command === "pause" ? "用户已暂停任务；继续时先重新观察屏幕并核对未完成操作。"
    : command === "cancel" ? "用户已取消当前单次任务。"
      : "用户已重试任务；先重新观察屏幕并恢复进度。";
  const intent = reply ? `${value.intent}；用户补充：${String(reply).slice(0, 1200)}` : value.intent;
  const retryAfterTimeLimit = command === "resume" && value.waiting?.category === "goal-time-limit";
  const nextWaiting = command === "resume" ? null : value.waiting;
  const sequence = Number(value.journalSequence || 0) + 1;
  const event = { at: now, step: Number(value.step || 0), phase: `user-control.${command}`,
    source: "user", replyLength: command === "resume" ? String(reply).length : 0,
    queuedCancelled, ...(retryAfterTimeLimit ? { retryAfterGoalTimeLimit: true } : {}) };
  const nextActive = {
    ...value,
    state: control.state,
    progress,
    intent,
    waiting: nextWaiting,
    pausedAt: command === "pause" ? now : value.pausedAt,
    cancelledAt: command === "cancel" ? now : value.cancelledAt,
    recoveryAttempts: command === "resume" ? 0 : value.recoveryAttempts,
    revision: Number(value.revision || 0) + 1,
    lastProgressAt: now,
    journalSequence: sequence,
    trace: [...(Array.isArray(value.trace) ? value.trace : []), event].slice(-80),
    ...(retryAfterTimeLimit ? {
      goalAttemptStartedAt: now,
      goalDeadlineAt: now + 30 * 60_000,
      runId: `${Number(now).toString(36)}-${random().toString(36).slice(2, 8)}`,
      attempt: Number(value.attempt || 1) + 1,
    } : {}),
  };
  const operations = [put(ACTIVE_COLLECTION, ACTIVE_KEY, nextActive, activeRecord.revision)];
  const journal = makeJournalEntry(nextActive, sequence, event);
  operations.push(put("agent-events", journal.key, journal.value, "absent"));
  const goal = goalRecord;
  const task = taskRecord;
  if (goal?.value) operations.push(put("goals", `g:${value.goalId}`, {
    ...goal.value,
    state: control.state,
    progress,
    revision: Number(goal.value.revision || 0) + 1,
    updatedAt: now,
  }, goal.revision));
  if (task?.value) operations.push(put("tasks", `t:${value.taskId}`, {
    ...task.value,
    state: control.taskState,
    progress,
    waiting: command === "pause" ? { reason: progress, since: now } : null,
    revision: Number(task.value.revision || 0) + 1,
    updatedAt: now,
  }, task.revision));
  return { updated: true, queuedCancelled, intent, nextActive, operations };
}
