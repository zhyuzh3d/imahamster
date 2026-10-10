export function startActiveSegment(state, now = Date.now()) {
  if (!state) return;
  if (!Number.isFinite(state.activeElapsedMs)) state.activeElapsedMs = 0;
  if (!state.activeSegmentStartedAt) {
    state.activeSegmentStartedAt = now;
    if (state.actionLoop?.status === "running" && !state.actionLoop.segmentStartedAt) {
      state.actionLoop.segmentStartedAt = now;
    }
  }
}

export function finishActiveSegment(state, now = Date.now()) {
  if (!state?.activeSegmentStartedAt) return 0;
  const elapsed = Math.max(0, now - state.activeSegmentStartedAt);
  state.activeElapsedMs = Number(state.activeElapsedMs || 0) + elapsed;
  if (state.actionLoop?.status === "running") {
    state.actionLoop.elapsedMs = Number(state.actionLoop.elapsedMs || 0) + elapsed;
    state.actionLoop.segmentStartedAt = null;
  }
  state.activeSegmentStartedAt = null;
  return elapsed;
}

export function actionLoopElapsedMs(state, now = Date.now()) {
  if (!state?.actionLoop) return 0;
  const current = state.actionLoop.segmentStartedAt
    ? Math.max(0, now - state.actionLoop.segmentStartedAt)
    : 0;
  return Number(state.actionLoop.elapsedMs || 0) + current;
}

export function actionLoopExpired(state, {
  now = Date.now(),
  defaultBudgetMinutes = 15,
} = {}) {
  return state?.actionLoop?.status === "running" &&
    actionLoopElapsedMs(state, now) >= Number(state.actionLoop.budgetMinutes || defaultBudgetMinutes) * 60_000;
}

export function ensureGoalDeadline(state, { now = Date.now(), maxDurationMs = 30 * 60_000 } = {}) {
  if (!state) return null;
  if (!Number.isFinite(state.goalAttemptStartedAt)) state.goalAttemptStartedAt = Number(state.createdAt) || now;
  if (!Number.isFinite(state.goalDeadlineAt)) state.goalDeadlineAt = state.goalAttemptStartedAt + maxDurationMs;
  return state.goalDeadlineAt;
}

export function goalDeadlineExpired(state, options = {}) {
  const deadline = ensureGoalDeadline(state, options);
  return deadline !== null && (options.now ?? Date.now()) >= deadline;
}

export function beginActionLoop(state, reason, now = Date.now()) {
  const previous = state.actionLoop;
  const index = Math.max(Number(state.actionLoopIndex) || 0, Number(previous?.index) || 0) + 1;
  if (previous && Number(previous.index) > 0) {
    if (!Array.isArray(state.actionLoopHistory)) state.actionLoopHistory = [];
    if (!state.actionLoopHistory.some((item) => item.index === previous.index)) {
      const archived = { ...previous };
      delete archived.segmentStartedAt;
      archived.endedAt = Number(archived.endedAt) || now;
      archived.endReason = reason;
      state.actionLoopHistory.push(archived);
      if (state.actionLoopHistory.length > 32) state.actionLoopHistory.splice(0, state.actionLoopHistory.length - 32);
    }
  }
  state.actionLoopIndex = index;
  state.actionLoop = {
    index,
    status: "planning",
    elapsedMs: 0,
    segmentStartedAt: null,
    planReason: reason,
    startedAt: now,
  };
  return state.actionLoop;
}

export function finishActionLoop(state, status, now = Date.now()) {
  if (!state?.actionLoop) return null;
  state.actionLoop.status = status;
  state.actionLoop.endedAt = now;
  return state.actionLoop;
}
