const DEFAULT_GOAL_COMPLETION = "由模型依据连续截图与操作结果复核用户目标";

export function goalPlanFromRecord(goal) {
  return {
    scope: goal?.scope && typeof goal.scope === "object" ? goal.scope : {},
    triggers: Array.isArray(goal?.triggers) ? goal.triggers : [],
    completion: typeof goal?.completion === "string" ? goal.completion : DEFAULT_GOAL_COMPLETION,
    priority: Number.isFinite(Number(goal?.priority)) ? Number(goal.priority) : 0,
    acceptedBoundary: typeof goal?.acceptedBoundary === "string" ? goal.acceptedBoundary : "after-creation",
  };
}

export function taskPlanFromRecord(task) {
  return {
    dependencies: Array.isArray(task?.dependencies) ? task.dependencies : [],
    objectKey: task?.objectKey ?? null,
  };
}

export function goalProgressRecord(state, goalState, now) {
  return {
    schemaVersion: 1, goalId: state.goalId, intent: state.intent,
    ...(state.goalPlan || goalPlanFromRecord(null)),
    ...(state.taskKind ? { taskKind: state.taskKind } : {}),
    ...(state.learningMaintenance ? { purpose: "learning-maintenance",
      sourceGoalId: state.learningMaintenance.sourceGoalId } : {}),
    ...(state.parentEventTaskId ? { parentEventTaskId: state.parentEventTaskId } : {}),
    ...(state.sourceEventId ? { sourceEventId: state.sourceEventId } : {}),
    state: goalState, revision: state.revision, progress: state.progress,
    createdAt: state.createdAt, updatedAt: now,
    completedAt: state.state === "done" ? now : undefined,
    evidenceRefs: state.state === "done" ? state.learningMaintenance
      ? [`goal:${state.learningMaintenance.sourceGoalId}:result`] : [`screen-step:${state.step}`] : undefined,
  };
}

export function taskProgressRecord(state, taskState, now) {
  return {
    schemaVersion: 1, taskId: state.taskId, goalId: state.goalId, runId: state.runId,
    revision: state.revision, kind: state.taskRecordKind || "screen-work", objective: state.taskObjective || state.intent, state: taskState,
    ...(state.taskPlan || taskPlanFromRecord(null)),
    ...(state.parentEventTaskId ? { parentEventTaskId: state.parentEventTaskId } : {}),
    ...(state.sourceEventId ? { sourceEventId: state.sourceEventId } : {}),
    progress: state.progress, waiting: state.waiting,
    resultRefs: state.learningMaintenance ? [`goal:${state.learningMaintenance.sourceGoalId}:result`]
      : [`screen-step:${state.step}`],
    createdAt: state.createdAt, updatedAt: now,
  };
}
