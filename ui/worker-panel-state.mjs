const TERMINAL_GOAL_STATES = new Set(["done", "failed", "cancelled"]);

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
  const acceptedAt = Number(lastResult?.acceptedAt || 0);
  const persistedCurrentGoal = !!active && active.intent === lastResult?.goalIntent &&
    Number(active.createdAt || 0) >= acceptedAt - 5000;
  const interruptedHandoff = serviceState === "failed" && lastResult?.status === "running" &&
    (!persistedCurrentGoal || !TERMINAL_GOAL_STATES.has(active?.state));
  const orphanedHandoff = interruptedHandoff && !persistedCurrentGoal;
  const queueRecoveryNeedsUser = active?.postTaskQueueRecovery?.kind === "inbox-drain" &&
    active.postTaskQueueRecovery.userRequired === true;
  const visible = (!!active && !TERMINAL_GOAL_STATES.has(active.state)) || queuedCount > 0 ||
    !!active?.trace?.length || liveEventTasks.length > 0 || interruptedHandoff || queueRecoveryNeedsUser;
  const activeCanControl = !!active && !["done", "cancelled", "event-driven"].includes(active.state);
  const resumeEnabled = orphanedHandoff || queueRecoveryNeedsUser || (activeCanControl &&
    (active.state === "paused" || active?.waiting?.userRequired || active.state === "failed" || serviceState !== "running"));
  return { active, liveEventTasks, visible, interruptedHandoff, orphanedHandoff, persistedCurrentGoal,
    queueRecoveryNeedsUser, activeCanControl, resumeEnabled, taskGraphProgress: taskGraphProgress(active) };
}
