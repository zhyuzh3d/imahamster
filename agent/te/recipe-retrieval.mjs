import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";
import { normalizeToolRecipeRecord } from "./recipe.mjs";

/** Retrieve a small set of relevant active recipes with their provenance. */
export function retrieveRelevantToolRecipes(intent, items, { limit = 3 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("TE 工具配方检索参数无效");
  }
  const query = tokenizeKeywords(intent);
  if (!query.size || limit === 0) return [];

  return items.map((item, index) => {
    const value = normalizeToolRecipeRecord(item);
    if (!value) return null;
    const recipeText = `${value.name} ${value.purpose} ${value.applicability} ${value.steps.map(step => step.purpose).join(" ")}`;
    const score = keywordOverlapScore(query, tokenizeKeywords(recipeText));
    return score ? { value, score, index } : null;
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score ||
      Number(right.value.createdAt || 0) - Number(left.value.createdAt || 0) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}
