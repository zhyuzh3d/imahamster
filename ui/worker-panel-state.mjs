const TERMINAL_GOAL_STATES = new Set(["done", "failed", "cancelled"]);

export function deriveWorkerPanelState({ activeRecord, queuedCount = 0, serviceState, lastResult, eventTasks = [] }) {
  const active = activeRecord?.value || null;
  const liveEventTasks = eventTasks.map(item => item?.value).filter(item => item && item.state !== "cancelled");
  const acceptedAt = Number(lastResult?.acceptedAt || 0);
  const persistedCurrentGoal = !!active && active.intent === lastResult?.goalIntent &&
    Number(active.createdAt || 0) >= acceptedAt - 5000;
  const interruptedHandoff = serviceState === "failed" && lastResult?.status === "running" &&
    (!persistedCurrentGoal || !TERMINAL_GOAL_STATES.has(active?.state));
  const orphanedHandoff = interruptedHandoff && !persistedCurrentGoal;
  const visible = (!!active && !TERMINAL_GOAL_STATES.has(active.state)) || queuedCount > 0 ||
    !!active?.trace?.length || liveEventTasks.length > 0 || interruptedHandoff;
  const activeCanControl = !!active && !["done", "cancelled", "event-driven"].includes(active.state);
  const resumeEnabled = orphanedHandoff || (activeCanControl &&
    (active.state === "paused" || active?.waiting?.userRequired || active.state === "failed" || serviceState !== "running"));
  return { active, liveEventTasks, visible, interruptedHandoff, orphanedHandoff, persistedCurrentGoal, activeCanControl, resumeEnabled };
}
