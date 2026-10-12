const TERMINAL_GOAL_STATES = new Set(["done", "failed", "cancelled"]);

export function matchesPersistedGoal(active, lastResult) {
  if (!active || typeof lastResult?.goalIntent !== "string") return false;
  if (typeof lastResult.goalId === "string" && lastResult.goalId) return active.goalId === lastResult.goalId;
  return active.intent === lastResult.goalIntent &&
    Number(active.createdAt || 0) >= Number(lastResult.acceptedAt || 0) - 5000;
}

export function reconcileLastResultWithGoal(lastResult, goalRecord) {
  const goal = goalRecord?.value;
  if (lastResult?.status !== "running" || !goal?.goalId || goal.intent !== lastResult.goalIntent ||
      !TERMINAL_GOAL_STATES.has(goal.state)) return null;
  return {
    ...lastResult,
    goalId: goal.goalId,
    status: goal.state,
    summary: goal.progress || lastResult.summary || "单次目标已结束。",
    finishedAt: Number(goal.updatedAt || 0) || Date.now(),
  };
}

function taskGraphProgress(active) {
  const tasks = active?.taskGraph?.tasks;
  if (!Array.isArray(tasks) || tasks.length < 2 || tasks.length > 31) return null;
  const currentIndex = tasks.findIndex(task => task?.taskId === active.taskId);
  const current = currentIndex >= 0 ? tasks[currentIndex] : null;
  const reviewingGoal = active.taskReviewMode === true && active.taskId === active.taskGraph.coordinatorTaskId;
  const handoffPending = active.lastDecision?.state === "task-done" && current?.state === "done";
  const currentLabel = reviewingGoal ? "整体目标复核"
    : handoffPending ? "当前项已完成，等待 HO 调度下一项"
      : current ? `第 ${Number.isInteger(current.planIndex) ? current.planIndex + 1 : currentIndex + 1}/${tasks.length} 项：${String(current.objective || "").slice(0, 120)}`
      : "等待 HO 恢复调度";
  return { completed: tasks.filter(task => task?.state === "done").length, total: tasks.length, currentLabel };
}

export function deriveWorkerPanelState({ activeRecord, queuedCount = 0, serviceState, lastResult, eventTasks = [] }) {
  const active = activeRecord?.value || null;
  const liveEventTasks = eventTasks.map(item => item?.value).filter(item => item && item.state !== "cancelled");
  const persistedCurrentGoal = matchesPersistedGoal(active, lastResult);
  const interruptedHandoff = serviceState === "failed" && lastResult?.status === "running" &&
    (!persistedCurrentGoal || !TERMINAL_GOAL_STATES.has(active?.state));
  const orphanedHandoff = interruptedHandoff && !persistedCurrentGoal;
  const queueRecoveryNeedsUser = active?.postTaskQueueRecovery?.kind === "inbox-drain" &&
    active.postTaskQueueRecovery.userRequired === true;
  const learningCountValue = Number(active?.learningSaved);
  const learningCount = Number.isSafeInteger(learningCountValue) ? Math.max(0, learningCountValue) : 0;
  const showLearningStatus = !interruptedHandoff || persistedCurrentGoal;
  const learningLead = active?.learningMaintenance ? "后台经验整理" : "成功后经验整理";
  const learningStatus = showLearningStatus && active?.learningMaintenance &&
      ["active", "waiting"].includes(active.state) && active.learningStatus === "running"
    ? "后台经验整理进行中"
    : showLearningStatus && active?.state === "done" && active.learningStatus === "pending"
      ? `${learningLead}待完成`
      : showLearningStatus && active?.state === "done" && active.learningStatus === "complete"
        ? learningCount > 0
          ? `${learningLead}完成，保存 ${learningCount} 条`
          : `${learningLead}完成，无需新增条目`
        : showLearningStatus && active?.state === "done" && active.learningStatus === "skipped"
          ? `${learningLead}未完成：${String(active.learningError || "查看执行记录").slice(0, 180)}`
          : null;
  const visible = (!!active && !TERMINAL_GOAL_STATES.has(active.state)) || queuedCount > 0 ||
    !!active?.trace?.length || liveEventTasks.length > 0 || interruptedHandoff || queueRecoveryNeedsUser || !!learningStatus;
  const activeCanControl = !!active && !["done", "cancelled", "event-driven"].includes(active.state);
  const resumeEnabled = orphanedHandoff || queueRecoveryNeedsUser || (activeCanControl &&
    (active.state === "paused" || active?.waiting?.userRequired || active.state === "failed" || serviceState !== "running"));
  return { active, liveEventTasks, visible, interruptedHandoff, orphanedHandoff, persistedCurrentGoal,
    queueRecoveryNeedsUser, learningStatus, activeCanControl, resumeEnabled, taskGraphProgress: taskGraphProgress(active) };
}
