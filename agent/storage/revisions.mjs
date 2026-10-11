const LIFECYCLE_COLLECTIONS = new Set(["agent-runtime", "goals", "tasks", "event-tasks"]);

function recordKey(collection, key) {
  return `${collection}\u0000${key}`;
}

function isTracked(collection, key) {
  if (typeof key !== "string" || !key) return false;
  if (collection === "agent-runtime") return key === "active-goal";
  if (collection === "event-tasks") return key.startsWith("ed:");
  return LIFECYCLE_COLLECTIONS.has(collection);
}

function hasRevision(record) {
  return typeof record?.revision === "string" && record.revision.length > 0;
}

function observeRecord(revisions, collection, key, revision) {
  if (!isTracked(collection, key)) return;
  if (typeof revision === "string" && revision) revisions.set(recordKey(collection, key), revision);
}

function observeMissingRecord(revisions, collection, key) {
  if (isTracked(collection, key)) revisions.set(recordKey(collection, key), "absent");
}

/** Add known Host revisions to lifecycle writes while preserving explicit caller conditions. */
export function prepareRevisionCheckedWrite(method, params, revisions) {
  if (!(revisions instanceof Map)) throw new TypeError("A lifecycle revision map is required");
  if (method === "data.put") {
    if (!isTracked(params?.collection, params?.key) || Object.hasOwn(params, "expectedRevision")) return params;
    const key = recordKey(params.collection, params.key);
    return revisions.has(key) ? { ...params, expectedRevision: revisions.get(key) } : params;
  }
  if (method !== "data.batch" || !Array.isArray(params?.operations)) return params;

  let changed = false;
  const operations = params.operations.map((operation) => {
    if (!isTracked(operation?.collection, operation?.key) || Object.hasOwn(operation, "expectedRevision")) return operation;
    const key = recordKey(operation.collection, operation.key);
    if (!revisions.has(key)) return operation;
    changed = true;
    return { ...operation, expectedRevision: revisions.get(key) };
  });
  return changed ? { ...params, operations } : params;
}

/** Learn record revisions only from acknowledged Haminn store results. */
export function observeStoreEffectResult(revisions, method, params, result) {
  if (!(revisions instanceof Map)) throw new TypeError("A lifecycle revision map is required");
  if (method === "data.get") {
    if (result == null) observeMissingRecord(revisions, params?.collection, params?.key);
    else observeRecord(revisions, params?.collection, params?.key, result.revision);
    return;
  }
  if (method === "data.scan") {
    for (const record of Array.isArray(result?.items) ? result.items : []) {
      observeRecord(revisions, record?.collection || params?.collection, record?.key, record?.revision);
    }
    return;
  }
  if (method === "data.put") {
    observeRecord(revisions, params?.collection, params?.key, result?.revision);
    return;
  }
  if (method === "data.delete") {
    if (result?.deleted === true || result?.deleted === false) {
      observeMissingRecord(revisions, params?.collection, params?.key);
    }
    return;
  }
  if (method !== "data.batch") return;

  const operations = Array.isArray(params?.operations) ? params.operations : [];
  const results = Array.isArray(result?.results) ? result.results : [];
  operations.forEach((operation, index) => {
    const outcome = results[index];
    if (operation?.op === "delete") {
      if (outcome?.op === "delete" || typeof outcome?.deleted === "boolean") {
        observeMissingRecord(revisions, operation.collection, operation.key);
      }
    } else if (operation?.op === "put" && outcome?.revision) {
      observeRecord(revisions, operation.collection, operation.key, outcome.revision);
    }
  });
}

/** Reject malformed Host results that would otherwise make later writes unconditional. */
export function lifecycleStoreContractError(method, params, result) {
  if (method === "data.get" && isTracked(params?.collection, params?.key) && result != null && !hasRevision(result)) {
    return "lifecycle data.get result is missing its Host revision";
  }
  if (method === "data.scan") {
    const malformed = (Array.isArray(result?.items) ? result.items : []).some(record =>
      isTracked(record?.collection || params?.collection, record?.key) && !hasRevision(record));
    if (malformed) return "lifecycle data.scan result is missing a Host revision";
  }
  if (method === "data.put" && isTracked(params?.collection, params?.key) && !hasRevision(result)) {
    return "lifecycle data.put result is missing its Host revision";
  }
  if (method === "data.delete" && isTracked(params?.collection, params?.key) &&
      typeof result?.deleted !== "boolean") {
    return "lifecycle data.delete result is missing its deletion acknowledgement";
  }
  if (method === "data.batch" && Array.isArray(params?.operations)) {
    const results = Array.isArray(result?.results) ? result.results : [];
    for (const [index, operation] of params.operations.entries()) {
      if (!isTracked(operation?.collection, operation?.key)) continue;
      const outcome = results[index];
      if (operation.op === "put" && !hasRevision(outcome)) {
        return "lifecycle data.batch put result is missing its Host revision";
      }
      if (operation.op === "delete" && outcome?.op !== "delete" && typeof outcome?.deleted !== "boolean") {
        return "lifecycle data.batch delete result is missing its deletion acknowledgement";
      }
    }
  }
  return null;
}

export function hasLifecycleWrite(method, params) {
  if (method === "data.put") return isTracked(params?.collection, params?.key);
  if (method !== "data.batch" || !Array.isArray(params?.operations)) return false;
  return params.operations.some((operation) => isTracked(operation?.collection, operation?.key));
}

export function knowsLifecycleRevision(revisions, collection, key) {
  if (!(revisions instanceof Map)) throw new TypeError("A lifecycle revision map is required");
  return revisions.has(recordKey(collection, key));
}

export function clearLifecycleRevisions(revisions) {
  if (!(revisions instanceof Map)) throw new TypeError("A lifecycle revision map is required");
  revisions.clear();
}
