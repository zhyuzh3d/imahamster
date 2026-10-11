import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";

const PATTERN_FIELDS = ["title", "condition", "guidance", "evidence"];

function patternValue(item) {
  const value = item?.value || item;
  if (!value || typeof value !== "object" || value.type !== "behavior-pattern" || value.state !== "active") return null;
  if (value.scope !== "global" || PATTERN_FIELDS.some(name =>
    typeof value[name] !== "string" || !value[name].trim() || value[name].length > 800)) return null;
  return {
    schemaVersion: 1,
    type: "behavior-pattern",
    state: "active",
    scope: "global",
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `self-model:${item.key}` } : {}),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
    title: value.title.trim().slice(0, 120),
    condition: value.condition.trim().slice(0, 240),
    guidance: value.guidance.trim().slice(0, 500),
    evidence: value.evidence.trim().slice(0, 300),
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
  };
}

/** Return only short, relevant global self-model patterns; they are advice data, not authority. */
export function retrieveBehaviorPatterns(intent, items, { limit = 5 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("SM 行为模式检索参数无效");
  }
  const query = tokenizeKeywords(intent);
  if (!query.size || limit === 0) return [];
  return items.map((item, index) => {
    const value = patternValue(item);
    if (!value) return null;
    const score = keywordOverlapScore(query, tokenizeKeywords(PATTERN_FIELDS.map(field => value[field]).join(" ")));
    return score ? { value, score, index } : null;
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score ||
      Number(right.value.createdAt || 0) - Number(left.value.createdAt || 0) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}

export function normalizeBehaviorPattern(candidate, { sourceGoalId, at = Date.now() } = {}) {
  if (!candidate || typeof candidate !== "object" || typeof sourceGoalId !== "string" || !sourceGoalId) return null;
  const fields = [candidate.title, candidate.condition, candidate.guidance, candidate.evidence];
  if (fields.some(value => typeof value !== "string" || !value.trim() || value.length > 800)) return null;
  return {
    schemaVersion: 1,
    type: "behavior-pattern",
    state: "active",
    scope: "global",
    title: candidate.title.trim().slice(0, 120),
    condition: candidate.condition.trim().slice(0, 240),
    guidance: candidate.guidance.trim().slice(0, 500),
    evidence: candidate.evidence.trim().slice(0, 300),
    sourceGoalId,
    createdAt: at,
  };
}
