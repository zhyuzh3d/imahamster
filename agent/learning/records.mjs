import { normalizeMemorySuggestion } from "../me/memory.mjs";
import { normalizeBehaviorPattern } from "../sm/behavior-patterns.mjs";
import { isRegisteredTool } from "../te/catalog.mjs";
import { normalizeToolRecipeRecord, prepareToolRecipeEdit } from "../te/recipe.mjs";

function toolRefs(value) {
  return Array.isArray(value) ? [...new Set(value.filter(isRegisteredTool))].slice(0, 8) : [];
}

/** Prepare bounded learning records without performing storage effects. */
export function prepareLearningRecords(suggestion, {
  goalId,
  progress,
  history = [],
  now = Date.now(),
} = {}) {
  const records = [];
  const skipped = [];
  const traceHistory = Array.isArray(history) ? history : [];
  if (!suggestion || typeof suggestion !== "object" || typeof goalId !== "string" || !goalId || !progress) {
    return { records, skipped: ["学习上下文缺少完成目标"] };
  }

  if (suggestion.savePattern === true && suggestion.pattern) {
    const pattern = normalizeBehaviorPattern(suggestion.pattern, { sourceGoalId: goalId, at: now });
    if (pattern) records.push({ collection: "self-model", key: `bp:${goalId}`, value: pattern });
  }
  if (suggestion.saveExperience === true && suggestion.experience) {
    const item = suggestion.experience;
    const fields = [item.title, item.situation, item.approach, item.successEvidence];
    if (fields.every(value => typeof value === "string" && value.trim() && value.length <= 800)) {
      records.push({ collection: "knowledge", key: `experience:${goalId}`, value: {
        schemaVersion: 1, type: "experience", state: "active", title: item.title.trim(),
        situation: item.situation.trim(), approach: item.approach.trim(), successEvidence: item.successEvidence.trim(),
        toolRefs: toolRefs(item.toolRefs), sourceGoalId: goalId, revision: 1, createdAt: now,
      } });
    }
  }
  if (suggestion.saveMemory === true && Array.isArray(suggestion.memories)) {
    const sourceTimes = Object.fromEntries(traceHistory.map(item => [item.sourceRef, Number(item.at) || 0]));
    const allowedSourceRefs = new Set(Object.keys(sourceTimes).filter(Boolean));
    suggestion.memories.slice(0, 3).forEach((item, index) => {
      const value = normalizeMemorySuggestion(item, { goalId, allowedSourceRefs, sourceTimes, at: now });
      if (!value) return;
      value.id = `memory:${goalId}:${index + 1}`;
      records.push({ collection: "knowledge", key: value.id, value });
    });
  }
  if (suggestion.saveRecipe === true && suggestion.recipe) {
    try {
      const item = suggestion.recipe;
      const allowedSourceRefs = new Set(traceHistory.map(entry => entry.sourceRef).filter(Boolean));
      const sourceRefs = Array.isArray(item.sourceRefs)
        ? [...new Set(item.sourceRefs.filter(ref => typeof ref === "string" && allowedSourceRefs.has(ref)))].slice(0, 24)
        : [];
      if (!sourceRefs.length) throw new Error("配方没有引用有效任务轨迹来源");
      const value = prepareToolRecipeEdit({ type: "tool-recipe", state: "active", revision: 0,
        sourceGoalId: goalId, sourceRefs }, {
        name: item.name, purpose: item.purpose, applicability: item.applicability, steps: item.steps,
      }, now);
      if (!normalizeToolRecipeRecord({ value })) throw new Error("配方结构无效");
      records.push({ collection: "knowledge", key: `tool-recipe:${goalId}`, value });
    } catch (error) {
      skipped.push(String(error?.message || error).slice(0, 180));
    }
  }
  if (suggestion.saveTool === true && suggestion.tool) {
    const item = suggestion.tool;
    if (typeof item.name === "string" && item.name.trim().length <= 80 &&
        typeof item.description === "string" && item.description.trim().length <= 800) {
      const refs = toolRefs(item.toolRefs);
      if (refs.length) records.push({ collection: "knowledge", key: `tool-candidate:${goalId}`, value: {
        schemaVersion: 1, type: "tool-candidate", state: "candidate", name: item.name.trim(),
        description: item.description.trim(), toolRefs: refs, sourceGoalId: goalId, createdAt: now,
      } });
    }
  }
  return { records, skipped };
}
