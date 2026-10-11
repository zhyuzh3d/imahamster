const MAX_PENDING_OPERATION_REFERENCES = 40;
const RESOLVED_STATUSES = new Set(["verified", "not-executed", "failed"]);

function summaryOf(operation) {
  return {
    operationId: String(operation.operationId || "").slice(0, 160),
    status: String(operation.status || "unknown").slice(0, 32),
    kind: String(operation.kind || "unknown").slice(0, 48),
    target: String(operation.target || "").slice(0, 120),
    ...(operation.label ? { label: String(operation.label).slice(0, 80) } : {}),
    createdAt: Number(operation.createdAt) || null,
    ...(Number.isFinite(operation.checkedAt) ? { checkedAt: operation.checkedAt } : {}),
  };
}

function compactReferences(state) {
  if (!Array.isArray(state.pendingOperations)) state.pendingOperations = [];
  const unique = new Map();
  for (const item of state.pendingOperations) {
    if (!item || typeof item.operationId !== "string" || !item.operationId) continue;
    if (RESOLVED_STATUSES.has(item.status)) continue;
    unique.set(item.operationId, summaryOf(item));
  }
  const values = [...unique.values()].sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  if (values.length > MAX_PENDING_OPERATION_REFERENCES) {
    const dropped = values.length - MAX_PENDING_OPERATION_REFERENCES;
    state.pendingOperationReferenceOverflow = Number(state.pendingOperationReferenceOverflow || 0) + dropped;
    values.splice(0, dropped);
  }
  state.pendingOperations = values;
  return values;
}

/** Keep a compact pointer to an unresolved operation; the full record remains in operations. */
export function rememberPendingOperation(state, operation = state?.pendingOperation) {
  if (!state || !operation?.operationId || RESOLVED_STATUSES.has(operation.status)) return [];
  const references = compactReferences(state);
  const summary = summaryOf(operation);
  const index = references.findIndex(item => item.operationId === summary.operationId);
  if (index >= 0) references[index] = summary;
  else references.push(summary);
  references.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  if (references.length > MAX_PENDING_OPERATION_REFERENCES) {
    const dropped = references.length - MAX_PENDING_OPERATION_REFERENCES;
    state.pendingOperationReferenceOverflow = Number(state.pendingOperationReferenceOverflow || 0) + dropped;
    references.splice(0, dropped);
  }
  return references;
}

/** Update the current operation's model-reported outcome without losing older unknown effects. */
export function applyCurrentOperationOutcome(state, result, evidence, at = Date.now()) {
  if (!state?.pendingOperationId || !state.pendingOperation) return null;
  const operation = {
    ...state.pendingOperation,
    status: result === "verified" ? "verified" : result === "not-executed" ? "not-executed" : "unknown",
    verificationEvidence: String(evidence || "").slice(0, 1000),
    checkedAt: at,
    updatedAt: at,
  };
  state.pendingOperation = operation;
  const references = compactReferences(state).filter(item => item.operationId !== operation.operationId);
  state.pendingOperations = references;
  if (operation.status === "unknown") rememberPendingOperation(state, operation);
  else state.pendingOperationId = null;
  return operation;
}

/** Seed the compact index when restoring state written before pendingOperations existed. */
export function ensurePendingOperationHistory(state) {
  if (!state || typeof state !== "object") return [];
  compactReferences(state);
  if (state?.pendingOperationId && state.pendingOperation && !RESOLVED_STATUSES.has(state.pendingOperation.status)) {
    rememberPendingOperation(state, state.pendingOperation);
  }
  return state.pendingOperations;
}

export function pendingOperationContext(state, { limit = 8, currentContentLimit = 8192 } = {}) {
  const references = Array.isArray(state?.pendingOperations)
    ? state.pendingOperations.filter(item => item && typeof item.operationId === "string" && !RESOLVED_STATUSES.has(item.status))
      .map(summaryOf)
    : [];
  const currentId = state?.pendingOperationId || null;
  if (currentId && state.pendingOperation && !RESOLVED_STATUSES.has(state.pendingOperation.status) &&
      !references.some(item => item.operationId === currentId)) references.push(summaryOf(state.pendingOperation));
  references.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  const visible = references.slice(-Math.max(1, Math.min(20, limit)));
  const entries = visible.map(item => ({ ...item }));
  if (currentId && state.pendingOperation) {
    const current = summaryOf(state.pendingOperation);
    const existing = entries.findIndex(item => item.operationId === currentId);
    if (existing >= 0) entries[existing] = current;
    else entries.push(current);
    const active = entries.find(item => item.operationId === currentId);
    if (active) {
      active.current = true;
      active.intendedContent = String(state.pendingOperation.intendedContent || "").slice(0, currentContentLimit);
    }
  }
  const referenceIds = new Set(references.map(item => item.operationId));
  const shownReferenceCount = entries.filter(item => referenceIds.has(item.operationId)).length;
  const overflow = Number(state?.pendingOperationReferenceOverflow || 0);
  const hiddenCount = Math.max(0, references.length - shownReferenceCount) + overflow;
  return { items: entries, total: references.length + overflow, hiddenCount };
}
