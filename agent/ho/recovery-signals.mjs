const MAX_FAILURE_CATEGORIES = 12;
const MAX_FAILURE_COUNT = 9_999;
const MAX_TOTAL_FAILURES = 999_999;

function token(value, fallback, limit = 48) {
  const normalized = String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit);
  return normalized || fallback;
}

/** Keep cumulative recovery history bounded and free of error text or user content. */
export function recordRecoveryFailure(state, { stage, category, code } = {}) {
  if (!state || typeof state !== "object") return null;
  let signals = state.recoverySignals;
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) {
    signals = { total: 0, overflow: 0, categories: [] };
    state.recoverySignals = signals;
  }
  if (!Array.isArray(signals.categories)) signals.categories = [];
  if (signals.categories.length > MAX_FAILURE_CATEGORIES) {
    const removed = signals.categories.length - MAX_FAILURE_CATEGORIES;
    signals.categories = signals.categories.slice(-MAX_FAILURE_CATEGORIES);
    signals.overflow = Math.min(MAX_TOTAL_FAILURES, Math.max(0, Number(signals.overflow) || 0) + removed);
  }

  const entry = {
    stage: token(stage, "unknown-stage"),
    category: token(category, "unknown-error"),
    ...(code ? { code: token(code, "unknown-code", 32) } : {}),
  };
  signals.total = Math.min(MAX_TOTAL_FAILURES, Math.max(0, Number(signals.total) || 0) + 1);
  const existing = signals.categories.find(item => item.stage === entry.stage &&
    item.category === entry.category && (item.code || "") === (entry.code || ""));
  if (existing) {
    existing.count = Math.min(MAX_FAILURE_COUNT, Math.max(0, Number(existing.count) || 0) + 1);
  } else if (signals.categories.length < MAX_FAILURE_CATEGORIES) {
    signals.categories.push({ ...entry, count: 1 });
  } else {
    signals.overflow = Math.min(MAX_TOTAL_FAILURES, Math.max(0, Number(signals.overflow) || 0) + 1);
  }
  return { ...entry, count: existing ? existing.count : 1, total: signals.total };
}

export function recoverySignalSummary(state) {
  const signals = state?.recoverySignals;
  if (!signals || typeof signals !== "object") return { total: 0, overflow: 0, categories: [] };
  return {
    total: Math.max(0, Number(signals.total) || 0),
    overflow: Math.max(0, Number(signals.overflow) || 0),
    categories: Array.isArray(signals.categories)
      ? signals.categories.slice(-MAX_FAILURE_CATEGORIES).map(item => ({
        stage: token(item?.stage, "unknown-stage"),
        category: token(item?.category, "unknown-error"),
        ...(item?.code ? { code: token(item.code, "unknown-code", 32) } : {}),
        count: Math.max(0, Number(item?.count) || 0),
      }))
      : [],
  };
}
