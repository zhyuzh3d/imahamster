export const GoalState = Object.freeze({ ACTIVE: "active", PAUSED: "paused", DONE: "done", CANCELLED: "cancelled" });
export const TaskState = Object.freeze({
  READY: "ready",
  RUNNING: "running",
  WAITING: "waiting",
  PAUSED: "paused",
  DONE: "done",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const transitions = Object.freeze({
  ready: new Set(["running", "waiting", "paused", "cancelled", "failed"]),
  running: new Set(["ready", "waiting", "paused", "done", "failed", "cancelled"]),
  waiting: new Set(["ready", "paused", "cancelled", "failed"]),
  paused: new Set(["ready", "cancelled"]),
  done: new Set(),
  failed: new Set(["ready", "cancelled"]),
  cancelled: new Set(),
});

export function assertTransition(from, to) {
  if (!transitions[from]?.has(to)) throw new Error(`Invalid Task transition: ${from} -> ${to}`);
}

export function newId(now = Date.now, random = Math.random) {
  return `${Number(now()).toString(36)}-${random().toString(36).slice(2, 12)}`;
}

export function validateGoal(goal) {
  if (!goal || typeof goal !== "object" || typeof goal.intent !== "string" || !goal.intent.trim()) {
    throw new TypeError("Goal intent is required");
  }
  if (!Object.values(GoalState).includes(goal.state)) throw new TypeError("Goal state is invalid");
  if (!Array.isArray(goal.triggers) || goal.triggers.length > 32) throw new TypeError("Goal triggers are invalid");
  return goal;
}

export function validateTask(task) {
  if (!task || typeof task !== "object" || typeof task.goalId !== "string" || !task.goalId) {
    throw new TypeError("Task goalId is required");
  }
  if (!Object.values(TaskState).includes(task.state)) throw new TypeError("Task state is invalid");
  if (!Array.isArray(task.dependencies) || task.dependencies.length > 64) {
    throw new TypeError("Task dependencies are invalid");
  }
  return task;
}

export function assertAcyclicTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new TypeError("Task dependencies contain a cycle");
    if (visited.has(taskId)) return;
    const task = byId.get(taskId);
    if (!task) throw new TypeError(`Unknown Task dependency: ${taskId}`);
    visiting.add(taskId);
    for (const dependencyId of task.dependencies) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
  return true;
}
