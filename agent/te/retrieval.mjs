import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";
import { normalizeToolCandidateRecord } from "./candidate.mjs";

/** Retrieve bounded, relevant tool-flow candidates without making them executable. */
export function retrieveRelevantToolCandidates(intent, items, { limit = 3 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("TE 工具候选检索参数无效");
  }
  const query = tokenizeKeywords(intent);
  if (!query.size || limit === 0) return [];

  return items.map((item, index) => {
    const value = normalizeToolCandidateRecord(item);
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
