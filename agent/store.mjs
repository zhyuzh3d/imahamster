import { GoalState, TaskState, assertTransition, newId, validateGoal, validateTask } from "./model.mjs";
import { normalizeTaskSpecifications } from "./ho/task-plan.mjs";

const COLLECTIONS = Object.freeze({
  GOALS: "goals",
  TASKS: "tasks",
  INBOX: "inbox",
  OPERATIONS: "operations",
});

export class AgentStore {
  constructor(data, { now = Date.now, id = () => newId(now) } = {}) {
    if (!data?.get || !data?.put || !data?.scan || !data?.batch) throw new TypeError("Haminn data API is required");
    this.data = data;
    this.now = now;
    this.id = id;
  }

  async get(collection, key) {
    return this.data.get({ collection, key });
  }

  async put(collection, key, value, expectedRevision = "absent") {
    return this.data.put({ collection, key, value, expectedRevision });
  }

  async batch(operations) {
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 100) {
      throw new RangeError("A Haminn record batch must contain 1 to 100 operations");
    }
    const seen = new Set();
    for (const item of operations) {
      const identity = `${item.collection}\u0000${item.key}`;
      if (seen.has(identity)) throw new TypeError("A batch cannot update the same record twice");
      seen.add(identity);
    }
    return this.data.batch({ operations });
  }

  async createGoal(intent, options = {}) {
    if (typeof intent !== "string" || !intent.trim() || intent.length > 16_000) {
      throw new TypeError("Goal intent must contain 1 to 16000 characters");
    }
    const at = this.now();
    const goalId = options.goalId || this.id();
    const value = validateGoal({
      schemaVersion: 1,
      goalId,
      intent: intent.trim(),
      scope: options.scope || {},
      triggers: options.triggers || [],
      completion: options.completion || "由模型依据任务证据复核用户目标",
      priority: Number.isFinite(options.priority) ? options.priority : 0,
      state: GoalState.ACTIVE,
      revision: 1,
      acceptedBoundary: options.acceptedBoundary || "after-creation",
      progress: "",
      createdAt: at,
      updatedAt: at,
    });
    await this.put(COLLECTIONS.GOALS, `g:${goalId}`, value);
    return value;
  }

  async createTask(goalId, fields = {}) {
    const goalKey = `g:${goalId}`;
    const goal = await this.get(COLLECTIONS.GOALS, goalKey);
    if (!goal || goal.value.state !== GoalState.ACTIVE) throw new Error("Task requires an active Goal");
    const at = this.now();
    const taskId = fields.taskId || this.id();
    const task = validateTask({
      schemaVersion: 1,
      taskId,
      goalId,
      runId: fields.runId || this.id(),
      revision: 1,
      kind: fields.kind || "work",
      objective: fields.objective || goal.value.intent,
      state: TaskState.READY,
      dependencies: fields.dependencies || [],
      objectKey: fields.objectKey || null,
      progress: "",
      waiting: null,
      resultRefs: [],
      createdAt: at,
      updatedAt: at,
    });
    for (const dependencyId of task.dependencies) {
      const dependency = await this.get(COLLECTIONS.TASKS, `t:${dependencyId}`);
      if (!dependency || dependency.value.goalId !== goalId) {
        throw new TypeError(`Task dependency is missing from this Goal: ${dependencyId}`);
      }
    }
    const nextGoal = { ...goal.value, revision: goal.value.revision + 1, lastTaskCreatedAt: at, updatedAt: at };
    await this.batch([
      { op: "put", collection: COLLECTIONS.TASKS, key: `t:${taskId}`, expectedRevision: "absent", value: task },
      { op: "put", collection: COLLECTIONS.GOALS, key: goalKey, expectedRevision: goal.revision, value: nextGoal },
    ]);
    return task;
  }

  async createTaskPlan(goalId, specifications) {
    if (!Array.isArray(specifications) || specifications.length < 1 || specifications.length > 32) {
      throw new RangeError("A Task plan must contain 1 to 32 tasks");
    }
    const goalKey = `g:${goalId}`;
    const goal = await this.get(COLLECTIONS.GOALS, goalKey);
    if (!goal || goal.value.state !== GoalState.ACTIVE) throw new Error("Task plan requires an active Goal");

    const at = this.now();
    const tasks = normalizeTaskSpecifications(specifications, {
      goalId, createdAt: at,
      makeTaskId: (_index, specification) => specification?.taskId || this.id(),
      makeRunId: (_index, specification) => specification?.runId || this.id(),
      defaultKind: "work", defaultObjective: goal.value.intent, firstState: TaskState.READY,
      minTasks: 1, maxTasks: 32, label: "Task",
    }).map(validateTask);

    const operations = tasks.map((task) => ({ op: "put", collection: COLLECTIONS.TASKS,
      key: `t:${task.taskId}`, expectedRevision: "absent", value: task }));
    operations.push({ op: "put", collection: COLLECTIONS.GOALS, key: goalKey,
      expectedRevision: goal.revision,
      value: { ...goal.value, revision: goal.value.revision + 1, lastTaskCreatedAt: at, updatedAt: at } });
    await this.batch(operations);
    return tasks;
  }

  async setGoalState(goalId, nextState) {
    if (![GoalState.ACTIVE, GoalState.PAUSED, GoalState.CANCELLED].includes(nextState)) {
      throw new TypeError("Goal state transition is invalid");
    }
    const key = `g:${goalId}`;
    const current = await this.get(COLLECTIONS.GOALS, key);
    if (!current) throw new Error(`Goal not found: ${goalId}`);
    if (current.value.state === nextState) return current;
    const allowed = {
      [GoalState.ACTIVE]: new Set([GoalState.PAUSED, GoalState.CANCELLED]),
      [GoalState.PAUSED]: new Set([GoalState.ACTIVE, GoalState.CANCELLED]),
      [GoalState.DONE]: new Set(),
      [GoalState.CANCELLED]: new Set(),
    };
    if (current.value.state !== nextState && !allowed[current.value.state]?.has(nextState)) {
      throw new Error(`Invalid Goal transition: ${current.value.state} -> ${nextState}`);
    }
    const value = { ...current.value, state: nextState, revision: current.value.revision + 1, updatedAt: this.now() };
    const result = await this.data.put({ collection: COLLECTIONS.GOALS, key, value,
      expectedRevision: current.revision });
    return { ...result, value };
  }

  async listGoals({ afterKey, limit = 100 } = {}) {
    return this.data.scan({ collection: COLLECTIONS.GOALS, prefix: "g:", afterKey, limit });
  }

  async completeGoal(goalId, { summary, evidenceRefs } = {}) {
    const invalidEvidence = evidenceRefs !== undefined && (!Array.isArray(evidenceRefs) || evidenceRefs.length > 100 ||
      evidenceRefs.some((ref) => typeof ref !== "string" || !ref));
    if (typeof summary !== "string" || !summary.trim() || summary.length > 4_000 || invalidEvidence) {
      throw new TypeError("Goal completion requires an LLM result summary and valid optional evidence references");
    }
    const goalKey = `g:${goalId}`;
    const goal = await this.get(COLLECTIONS.GOALS, goalKey);
    if (!goal || goal.value.state !== GoalState.ACTIVE) throw new Error("Only an active Goal can be completed");

    const at = this.now();
    const value = { ...goal.value, state: GoalState.DONE, progress: summary.trim(), evidenceRefs: evidenceRefs || [], completionSource: "llm",
      revision: goal.value.revision + 1, updatedAt: at, completedAt: at };
    const result = await this.data.put({ collection: COLLECTIONS.GOALS, key: goalKey, value,
      expectedRevision: goal.revision });
    return { ...result, value };
  }

  async listTasks(goalId, afterKey, limit = 100) {
    const page = await this.data.scan({ collection: COLLECTIONS.TASKS, prefix: "t:", afterKey, limit });
    return { ...page, items: page.items.filter((record) => record.value.goalId === goalId) };
  }

  async listReadyTasks({ afterKey, limit = 100 } = {}) {
    const page = await this.data.scan({ collection: COLLECTIONS.TASKS, prefix: "t:", afterKey, limit });
    const ready = [];
    for (const record of page.items) {
      if (record.value.state !== TaskState.READY) continue;
      const goal = await this.get(COLLECTIONS.GOALS, `g:${record.value.goalId}`);
      if (goal?.value.state !== GoalState.ACTIVE) continue;
      let dependenciesDone = true;
      for (const dependencyId of record.value.dependencies) {
        const dependency = await this.get(COLLECTIONS.TASKS, `t:${dependencyId}`);
        if (dependency?.value.state !== TaskState.DONE) {
          dependenciesDone = false;
          break;
        }
      }
      if (dependenciesDone) ready.push(record);
    }
    return { items: ready, nextAfterKey: page.nextAfterKey };
  }

  async transitionTask(taskId, nextState, patch = {}) {
    const key = `t:${taskId}`;
    const current = await this.get(COLLECTIONS.TASKS, key);
    if (!current) throw new Error(`Task not found: ${taskId}`);
    assertTransition(current.value.state, nextState);
    if (nextState === TaskState.RUNNING) {
      for (const dependencyId of current.value.dependencies) {
        const dependency = await this.get(COLLECTIONS.TASKS, `t:${dependencyId}`);
        if (dependency?.value.state !== TaskState.DONE) throw new Error(`Task dependency is not complete: ${dependencyId}`);
      }
    }
    const value = validateTask({ ...current.value, ...patch, state: nextState,
      revision: current.value.revision + 1, updatedAt: this.now() });
    if (nextState === TaskState.RUNNING) {
      const goalKey = `g:${current.value.goalId}`;
      const goal = await this.get(COLLECTIONS.GOALS, goalKey);
      if (goal?.value.state !== GoalState.ACTIVE) throw new Error("Task cannot run while its Goal is inactive");
      const at = this.now();
      const nextGoal = { ...goal.value, revision: goal.value.revision + 1, lastScheduledAt: at, updatedAt: at };
      const result = await this.batch([
        { op: "put", collection: COLLECTIONS.TASKS, key, expectedRevision: current.revision, value },
        { op: "put", collection: COLLECTIONS.GOALS, key: goalKey, expectedRevision: goal.revision, value: nextGoal },
      ]);
      return { ...result.results[0], value };
    }
    const result = await this.data.put({
      collection: COLLECTIONS.TASKS,
      key,
      value,
      expectedRevision: current.revision,
    });
    return { ...result, value };
  }

  async prepareOperation(taskId, action, identity) {
    if (!action || typeof action.tool !== "string" || !action.tool || typeof action.intent !== "string" || !action.intent) {
      throw new TypeError("Operation tool and intent are required");
    }
    const taskKey = `t:${taskId}`;
    const taskRecord = await this.get(COLLECTIONS.TASKS, taskKey);
    if (!taskRecord || taskRecord.value.state !== TaskState.RUNNING || taskRecord.value.pendingOperationId) {
      throw new Error("Task is not ready to dispatch an operation");
    }
    const goalRecord = await this.get(COLLECTIONS.GOALS, `g:${taskRecord.value.goalId}`);
    if (goalRecord?.value.state !== GoalState.ACTIVE) throw new Error("Goal is inactive; no operation may be dispatched");

    const operationId = this.id();
    const at = this.now();
    const operations = [{
      op: "put",
      collection: COLLECTIONS.OPERATIONS,
      key: `o:${operationId}`,
      expectedRevision: "absent",
      value: {
        schemaVersion: 1,
        operationId,
        taskId,
        goalId: taskRecord.value.goalId,
        runId: taskRecord.value.runId,
        taskRevision: taskRecord.value.revision,
        tool: action.tool,
        objectKey: taskRecord.value.objectKey,
        intent: action.intent,
        args: action.args || {},
        expectedResult: action.expectedResult || "",
        status: "prepared",
        createdAt: at,
        updatedAt: at,
      },
    }];

    let effect = null;
    if (action.effectKey) {
      if (!identity || typeof identity.accountKey !== "string" || typeof identity.objectKey !== "string") {
        throw new TypeError("Account and object identity are required for a repeatable effect");
      }
      const fingerprint = JSON.stringify([
        identity.accountKey,
        identity.objectKey,
        action.effectKey.intent,
        action.effectKey.contentAnchor || "",
      ]);
      const effectId = fnv1a64(fingerprint);
      const effectKey = `fx:${effectId}`;
      const existing = await this.get("objects", effectKey);
      if (existing) {
        if (existing.value.fingerprint !== fingerprint) throw new Error("Effect identity hash collision; operation was not dispatched");
        if (existing.value.status !== "failed") {
          throw Object.assign(new Error("An equivalent effect is already reserved"), {
            code: "E_CONFLICT",
            operationId: existing.value.operationId,
            status: existing.value.status,
          });
        }
        effect = { key: effectKey, fingerprint, revision: existing.revision };
      } else {
        effect = { key: effectKey, fingerprint, revision: "absent" };
      }
      operations.push({
        op: "put",
        collection: "objects",
        key: effectKey,
        expectedRevision: effect.revision,
        value: { fingerprint, operationId, taskId, goalId: taskRecord.value.goalId, status: "prepared", updatedAt: at },
      });
      operations[0].value.effectKey = effectKey;
    }

    const nextTask = {
      ...taskRecord.value,
      pendingOperationId: operationId,
      revision: taskRecord.value.revision + 1,
      updatedAt: at,
    };
    const nextGoal = { ...goalRecord.value, revision: goalRecord.value.revision + 1,
      lastDispatchedAt: at, updatedAt: at };
    operations.push({ op: "put", collection: COLLECTIONS.TASKS, key: taskKey,
      expectedRevision: taskRecord.revision, value: nextTask });
    operations.push({ op: "put", collection: COLLECTIONS.GOALS, key: `g:${taskRecord.value.goalId}`,
      expectedRevision: goalRecord.revision, value: nextGoal });
    await this.batch(operations);
    return { operationId, effectKey: effect?.key || null };
  }

  async updateOperation(operationId, status, patch = {}) {
    if (!["accepted", "unknown", "failed", "verified"].includes(status)) {
      throw new TypeError("Operation result status is invalid");
    }
    const operationKey = `o:${operationId}`;
    const operationRecord = await this.get(COLLECTIONS.OPERATIONS, operationKey);
    if (!operationRecord) throw new Error(`Operation not found: ${operationId}`);
    const allowed = {
      prepared: new Set(["accepted", "unknown", "failed"]),
      accepted: new Set(["unknown", "verified", "failed"]),
      unknown: new Set(["accepted", "failed", "verified"]),
      failed: new Set(),
      verified: new Set(),
    };
    if (!allowed[operationRecord.value.status]?.has(status)) {
      throw new Error(`Invalid Operation transition: ${operationRecord.value.status} -> ${status}`);
    }
    const at = this.now();
    const operation = { ...operationRecord.value, ...patch, status, updatedAt: at };
    const operations = [{ op: "put", collection: COLLECTIONS.OPERATIONS, key: operationKey,
      expectedRevision: operationRecord.revision, value: operation }];
    if (operationRecord.value.effectKey) {
      const effectKey = operationRecord.value.effectKey;
      const effectRecord = await this.get("objects", effectKey);
      if (effectRecord?.value.operationId === operationId) {
        operations.push({ op: "put", collection: "objects", key: effectKey,
          expectedRevision: effectRecord.revision,
          value: { ...effectRecord.value, status, updatedAt: at } });
      }
    }
    const taskKey = `t:${operationRecord.value.taskId}`;
    const taskRecord = await this.get(COLLECTIONS.TASKS, taskKey);
    if (taskRecord?.value.pendingOperationId === operationId) {
      operations.push({ op: "put", collection: COLLECTIONS.TASKS, key: taskKey,
        expectedRevision: taskRecord.revision,
        value: { ...taskRecord.value, pendingOperationId: status === "verified" || status === "failed" ? null : operationId,
          revision: taskRecord.value.revision + 1, updatedAt: at } });
    }
    await this.batch(operations);
    return operation;
  }

  async receiveEvent(event) {
    if (!event || typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 256) {
      throw new TypeError("An eventId of at most 256 characters is required");
    }
    const key = `e:${event.eventId}`;
    const current = await this.get(COLLECTIONS.INBOX, key);
    if (current) return { received: false, existing: current };
    const value = { ...event, schemaVersion: 1, receivedAt: this.now(), state: "received" };
    try {
      const record = await this.put(COLLECTIONS.INBOX, key, value);
      return { received: true, record: { ...record, value } };
    } catch (error) {
      if (error?.code !== "E_CONFLICT") throw error;
      return { received: false, existing: await this.get(COLLECTIONS.INBOX, key) };
    }
  }
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export const AgentCollections = COLLECTIONS;
