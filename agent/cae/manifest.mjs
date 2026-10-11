const LIMITS = Object.freeze({
  history: 20,
  actionLoops: 6,
  experiences: 5,
  memories: 5,
  memoryLookupRefs: 8,
  behaviorPatterns: 5,
  toolCandidates: 3,
  toolRecipes: 3,
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function sourceRef(collection, item) {
  if (typeof item?.sourceRef === "string" && item.sourceRef) return item.sourceRef.slice(0, 240);
  if (typeof item?.id === "string" && item.id) return `${collection}:${item.id}`.slice(0, 240);
  return null;
}

function selectedRecords(items, limit, collection) {
  return list(items).slice(0, limit).map(item => ({
    ref: sourceRef(collection, item),
    ...(item?.revision !== undefined ? { revision: String(item.revision).slice(0, 80) } : {}),
    ...(item?.recordRevision !== undefined ? { recordRevision: String(item.recordRevision).slice(0, 80) } : {}),
  })).filter(item => item.ref);
}

function selectedTaskGraph(state) {
  const graph = state.taskGraph;
  if (!Array.isArray(graph?.tasks) || !graph.tasks.length) return null;
  const indexById = new Map(graph.tasks.map(task => [task.taskId, Number(task.planIndex) + 1]));
  return {
    coordinatorTaskRef: graph.coordinatorTaskId ? `task:${String(graph.coordinatorTaskId).slice(0, 128)}` : null,
    currentTaskRef: state.taskId ? `task:${String(state.taskId).slice(0, 128)}` : null,
    review: state.taskReviewMode === true,
    tasks: graph.tasks.slice(0, 31).map(task => ({
      ref: `task:${String(task.taskId || "").slice(0, 128)}`,
      revision: Number(task.revision) || 0,
      state: String(task.state || "").slice(0, 32),
      dependsOn: (Array.isArray(task.dependencies) ? task.dependencies : []).map(id => indexById.get(id)).filter(Number.isFinite),
    })),
  };
}

function traceRef(goalId, event) {
  const at = Number(event?.at);
  const step = Number(event?.step);
  const phase = String(event?.phase || "").trim();
  if (!goalId || !Number.isFinite(at) || !Number.isFinite(step) || !phase) return null;
  return `trace:${String(goalId).slice(0, 120)}:${Math.floor(at)}:${Math.floor(step)}:${phase.slice(0, 48)}`;
}

/** Describe the bounded context assembled for one model call without copying private content. */
export function buildContextManifest(state, {
  purpose = "action",
  context = "",
  identityCore = null,
  selection = null,
} = {}) {
  if (!state || typeof state !== "object") throw new TypeError("CAE 清单需要有效的 OST 状态");
  const trace = list(state.trace);
  const history = trace.slice(-LIMITS.history);
  const loops = list(state.actionLoopHistory).slice(-LIMITS.actionLoops);
  const latestObservation = [...trace].reverse().find(event => event?.phase === "screenshot.received");
  const identityVersion = Math.max(0, Number(identityCore?.version) || 0);
  const selected = selection ? {
    history: [], actionLoops: [], experiences: [], memories: [], memoryLookupRefs: [],
    behaviorPatterns: [], toolCandidates: [], toolRecipes: [], identityCore: null, taskGraph: selectedTaskGraph(state),
    ...selection,
  } : {
    history: history.map(event => traceRef(state.goalId, event)).filter(Boolean),
    actionLoops: loops.map(item => ({ index: Number(item.index) || 0, status: String(item.status || "").slice(0, 40) })),
    experiences: selectedRecords(state.experiences, LIMITS.experiences, "knowledge"),
    memories: selectedRecords(state.memories, LIMITS.memories, "knowledge"),
    memoryLookupRefs: list(state.memoryLookupRefs).slice(0, LIMITS.memoryLookupRefs).map(value => String(value).slice(0, 120)),
    behaviorPatterns: selectedRecords(state.behaviorPatterns, LIMITS.behaviorPatterns, "self-model"),
    toolCandidates: selectedRecords(state.toolCandidates, LIMITS.toolCandidates, "knowledge"),
    toolRecipes: selectedRecords(state.toolRecipes, LIMITS.toolRecipes, "knowledge"),
    identityCore: identityCore?.content ? {
      source: identityVersion > 0 ? "user" : "package-default",
      version: identityVersion,
    } : null,
    taskGraph: selectedTaskGraph(state),
  };
  const omitted = selection ? {
    history: 0, actionLoops: 0, experiences: 0, memories: 0,
    memoryLookupRefs: 0, behaviorPatterns: 0, toolCandidates: 0, toolRecipes: 0,
  } : {
    history: Math.max(0, trace.length - LIMITS.history),
    actionLoops: Math.max(0, list(state.actionLoopHistory).length - LIMITS.actionLoops),
    experiences: Math.max(0, list(state.experiences).length - LIMITS.experiences),
    memories: Math.max(0, list(state.memories).length - LIMITS.memories),
    memoryLookupRefs: Math.max(0, list(state.memoryLookupRefs).length - LIMITS.memoryLookupRefs),
    behaviorPatterns: Math.max(0, list(state.behaviorPatterns).length - LIMITS.behaviorPatterns),
    toolCandidates: Math.max(0, list(state.toolCandidates).length - LIMITS.toolCandidates),
    toolRecipes: Math.max(0, list(state.toolRecipes).length - LIMITS.toolRecipes),
  };

  return {
    schemaVersion: 1,
    purpose: String(purpose).slice(0, 40),
    ostId: String(state.goalId || "").slice(0, 128),
    alId: Number(state.actionLoop?.index || 0),
    ...(latestObservation ? {
      currentObservationRef: traceRef(state.goalId, latestObservation),
      currentObservation: {
        at: Number(latestObservation.at) || null,
        step: Number(latestObservation.step) || 0,
        width: Number(latestObservation.width) || null,
        height: Number(latestObservation.height) || null,
      },
    } : {}),
    selected,
    omitted,
    contextCharacters: String(context).length,
    approximateContextTokens: Math.ceil(String(context).length / 4),
    tokenEstimate: "ceil(contextCharacters/4)",
  };
}
