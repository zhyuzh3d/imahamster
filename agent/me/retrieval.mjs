import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";

const EXPERIENCE_FIELDS = ["title", "situation", "approach", "successEvidence"];

function experienceValue(item) {
  const value = item?.value || item;
  if (!value || typeof value !== "object" || value.type !== "experience" || value.state !== "active") return null;
  const fields = {};
  for (const name of EXPERIENCE_FIELDS) {
    if (typeof value[name] !== "string" || !value[name].trim()) return null;
    fields[name] = value[name].trim().slice(0, name === "title" ? 120 : 800);
  }
  const toolRefs = Array.isArray(value.toolRefs)
    ? value.toolRefs.filter(name => typeof name === "string" && name.length <= 80).slice(0, 8)
    : [];
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    type: "experience",
    state: "active",
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `knowledge:${item.key}` } : {}),
    revision: Math.max(1, Number(value.revision) || 1),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
    ...fields,
    toolRefs,
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
    ...(Number.isFinite(Number(value.updatedAt)) ? { updatedAt: Number(value.updatedAt) } : {}),
  };
}

/** Rank active, validated experiences against the current user goal. */
export function retrieveRelevantExperiences(intent, items, { limit = 5 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("ME 经验检索参数无效");
  }
  const query = tokenizeKeywords(intent);
  if (!query.size || limit === 0) return [];

  return items.map((item, index) => {
    const value = experienceValue(item);
    if (!value) return null;
    const document = tokenizeKeywords(EXPERIENCE_FIELDS.map(field => value[field]).join(" "));
    const score = keywordOverlapScore(query, document);
    if (!score) return null;
    return { value, score, index };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score ||
      Number(right.value.updatedAt || right.value.createdAt || 0) - Number(left.value.updatedAt || left.value.createdAt || 0) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}
