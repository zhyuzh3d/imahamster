const MAX_SUBTASKS = 31;

/** Shared structural normalization for Worker and AgentStore Task plans. */
export function normalizeTaskSpecifications(specifications, {
  goalId,
  createdAt = Date.now(),
  makeTaskId = (index, specification) => specification?.taskId || `task-${index + 1}`,
  makeRunId = index => `${createdAt.toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  minTasks = 1,
  maxTasks = 32,
  firstState = "ready",
  defaultKind = "work",
  defaultObjective = "",
  label = "Task",
} = {}) {
  if (!Array.isArray(specifications) || specifications.length < minTasks || specifications.length > maxTasks) {
    throw new RangeError(`${label} plan must contain ${minTasks} to ${maxTasks} tasks`);
  }
  if (typeof goalId !== "string" || !goalId) {
    throw new TypeError("A Goal ID is required for a Task plan");
  }
  const taskIds = specifications.map((specification, index) => makeTaskId(index, specification));
  if (taskIds.some(id => typeof id !== "string" || !id) || new Set(taskIds).size !== taskIds.length) {
    throw new TypeError("Task plan contains missing or duplicate IDs");
  }
  const tasks = specifications.map((specification, index) => {
    const objective = typeof specification?.objective === "string" && specification.objective.trim()
      ? specification.objective : defaultObjective;
    if (!specification || typeof specification !== "object" || typeof objective !== "string" ||
        !objective.trim() || objective.length > 2400) {
      throw new TypeError(`${label} ${index} requires an objective of 1 to 2400 characters`);
    }
    const indexes = specification.dependencies ?? [];
    if (!Array.isArray(indexes) || indexes.length > index || indexes.some(value =>
      !Number.isInteger(value) || value < 0 || value >= index) || new Set(indexes).size !== indexes.length) {
      throw new TypeError(`${label} ${index} dependencies must reference distinct earlier tasks`);
    }
    const objectKey = specification.objectKey ?? null;
    if (objectKey !== null && (typeof objectKey !== "string" || objectKey.length > 240)) {
      throw new TypeError(`Subtask ${index} objectKey is invalid`);
    }
    const at = Number(createdAt);
    return {
      schemaVersion: 1,
      taskId: taskIds[index],
      goalId,
      runId: makeRunId(index),
      revision: 1,
      kind: typeof specification.kind === "string" && specification.kind ? specification.kind : defaultKind,
      objective: objective.trim(),
      state: index === 0 ? firstState : "ready",
      dependencies: indexes.map(dependencyIndex => taskIds[dependencyIndex]),
      objectKey,
      progress: "",
      waiting: null,
      resultRefs: [],
      createdAt: at,
      updatedAt: at,
      planIndex: index,
    };
  });
  return tasks;
}

/** Validate the LLM's decomposition and map dependency indexes to durable Task IDs. */
export function createTaskGraph(subtasks, {
  goalId,
  coordinatorTaskId,
  createdAt = Date.now(),
  makeTaskId = index => `${coordinatorTaskId}-s${index + 1}`,
  makeRunId = index => `${createdAt.toString(36)}-${index.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
  if (typeof coordinatorTaskId !== "string" || !coordinatorTaskId) {
    throw new TypeError("A coordinator Task ID is required");
  }
  if (!Array.isArray(subtasks) || subtasks.length < 2 || subtasks.length > MAX_SUBTASKS) {
    throw new RangeError(`A decomposed Goal must contain 2 to ${MAX_SUBTASKS} subtasks`);
  }
  const tasks = normalizeTaskSpecifications(subtasks, {
    goalId, createdAt, makeTaskId, makeRunId,
    minTasks: 2, maxTasks: MAX_SUBTASKS, firstState: "running", defaultKind: "screen-work", label: "Subtask",
  });
  if (tasks.some(task => task.taskId === coordinatorTaskId)) throw new TypeError("Coordinator and subtask IDs must be unique");
  return {
    coordinatorTaskId,
    tasks,
    currentTaskId: tasks[0].taskId,
    createdAt: Number(createdAt),
  };
}

/** Return the earliest ready subtask whose dependencies the LLM has completed. */
export function nextReadySubtask(graph) {
  const tasks = Array.isArray(graph?.tasks) ? graph.tasks : [];
  const byId = new Map(tasks.map(task => [task.taskId, task]));
  return tasks.find(task => task.state === "ready" && task.dependencies.every(id => byId.get(id)?.state === "done")) || null;
}

export function setSubtaskState(graph, taskId, state, { progress, at = Date.now() } = {}) {
  if (!graph || !Array.isArray(graph.tasks) || !["ready", "running", "waiting", "done", "cancelled"].includes(state)) {
    throw new TypeError("Task graph or next Task state is invalid");
  }
  let found = false;
  const tasks = graph.tasks.map(task => {
    if (task.taskId !== taskId) return task;
    found = true;
    return { ...task, state, revision: Number(task.revision || 0) + 1,
      ...(progress === undefined ? {} : { progress: String(progress).slice(0, 360) }), updatedAt: Number(at) };
  });
  if (!found) throw new Error(`Task is not in this Goal plan: ${taskId}`);
  return { ...graph, tasks };
}

export function taskGraphContext(graph, currentTaskId, { review = false } = {}) {
  if (!graph?.tasks?.length) return "";
  const current = graph.tasks.find(task => task.taskId === currentTaskId);
  const statuses = graph.tasks.map(task => ({
    index: Number(task.planIndex) + 1,
    objective: task.objective,
    state: task.state,
    dependencies: task.dependencies.map(id => graph.tasks.find(item => item.taskId === id)?.planIndex + 1),
  }));
  return review
    ? `Goal 子任务计划已逐项处理：${JSON.stringify(statuses)}。现在依据用户原始目标、全部子任务进展和当前画面自行判断整体目标是否完成；只有你确认整体目标完成时才返回 done。若仍需操作，继续 action；需要等待/用户信息时用 wait/ask。`
    : `当前 HO 调度的子任务 ${Number(current?.planIndex) + 1 || 1}/${graph.tasks.length}：${current?.objective || ""}。整体用户目标仍是上文原始指令。完成此子任务但整体目标尚未完成时返回 task-done，HO 会按依赖调度下一项；只有你确认整体目标完成时才返回 done。子任务列表：${JSON.stringify(statuses)}。`;
}
