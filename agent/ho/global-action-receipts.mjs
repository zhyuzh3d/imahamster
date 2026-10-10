const FINAL_STATES = new Set(["accepted", "rejected", "failed"]);

export const GLOBAL_ACTION_INITIAL_WAIT_MS = 1100;
export const GLOBAL_ACTION_POLL_WAIT_MS = 250;
export const MAX_GLOBAL_ACTION_STATUS_POLLS = 8;

export function beginGlobalActionReceipt(result, now = Date.now()) {
  const operationId = String(result?.operationId || "").slice(0, 128);
  if (result?.state !== "scheduled" || !operationId) return null;
  return {
    operationId,
    action: String(result.action || "").slice(0, 32),
    state: "scheduled",
    scheduledAt: Number(result.scheduledAt) || now,
    startedAt: now,
    polls: 0,
  };
}

export function classifyGlobalActionStatus(result, receipt) {
  const operationId = String(receipt?.operationId || result?.operationId || "").slice(0, 128);
  const action = String(result?.action || receipt?.action || "").slice(0, 32);
  if (!operationId || result?.found === false) {
    return { kind: "final", state: "unknown", operationId, action, polls: Number(receipt?.polls || 0) + 1, error: "status-not-found" };
  }

  const state = String(result?.state || "");
  if (state === "scheduled") {
    const polls = Number(receipt?.polls || 0) + 1;
    if (polls < MAX_GLOBAL_ACTION_STATUS_POLLS) {
      return { kind: "pending", state, operationId, action, polls };
    }
    return { kind: "final", state: "unknown", operationId, action, polls, error: "status-poll-limit" };
  }

  if (FINAL_STATES.has(state)) {
    return {
      kind: "final", state, operationId, action, polls: Number(receipt?.polls || 0) + 1,
      error: String(result?.error || "").slice(0, 160) || null,
      scheduledAt: Number(result?.scheduledAt) || Number(receipt?.scheduledAt) || null,
      finishedAt: Number(result?.finishedAt) || null,
    };
  }

  return { kind: "final", state: "unknown", operationId, action, polls: Number(receipt?.polls || 0) + 1, error: "invalid-status" };
}
