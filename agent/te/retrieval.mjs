import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";
import { isRegisteredTool } from "./catalog.mjs";

function candidateValue(item) {
  const value = item?.value || item;
  if (!value || typeof value !== "object" || value.type !== "tool-candidate" || value.state !== "candidate") return null;
  if (typeof value.name !== "string" || !value.name.trim() || typeof value.description !== "string" || !value.description.trim()) return null;
  const toolRefs = Array.isArray(value.toolRefs)
    ? [...new Set(value.toolRefs.filter(isRegisteredTool))].slice(0, 6)
    : [];
  if (!toolRefs.length) return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    type: "tool-candidate",
    state: "candidate",
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `knowledge:${item.key}` } : {}),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
    name: value.name.trim().slice(0, 80),
    description: value.description.trim().slice(0, 600),
    toolRefs,
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
  };
}

/** Retrieve bounded, relevant tool-flow candidates without making them executable. */
export function retrieveRelevantToolCandidates(intent, items, { limit = 3 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("TE 工具候选检索参数无效");
  }
  const query = tokenizeKeywords(intent);
  if (!query.size || limit === 0) return [];

  return items.map((item, index) => {
    const value = candidateValue(item);
    if (!value) return null;
    const score = keywordOverlapScore(query, tokenizeKeywords(`${value.name} ${value.description}`));
    if (!score) return null;
    return { value, score, index };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score ||
      Number(right.value.createdAt || 0) - Number(left.value.createdAt || 0) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}
