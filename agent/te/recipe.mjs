import { isRegisteredTool } from "./catalog.mjs";

const MAX_STEPS = 8;

function parseSteps(input) {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      throw new Error("工具配方步骤必须是有效 JSON 数组。");
    }
  }
  if (!Array.isArray(input) || input.length < 2 || input.length > MAX_STEPS) {
    throw new Error(`工具配方需要 2–${MAX_STEPS} 个有序步骤。`);
  }
  return input.map((step, index) => {
    const toolRef = String(step?.toolRef || "").trim();
    const purpose = String(step?.purpose || "").trim();
    if (!isRegisteredTool(toolRef) || !purpose || purpose.length > 240) {
      throw new Error(`第 ${index + 1} 步必须引用已注册工具并提供不超过 240 字的用途说明。`);
    }
    return { toolRef, purpose };
  });
}

/** Normalize a bounded, LLM-guided recipe; it never contains executable code. */
export function normalizeToolRecipeRecord(item, { includeInactive = false } = {}) {
  const value = item?.value || item;
  const states = includeInactive ? ["active", "inactive"] : ["active"];
  if (!value || typeof value !== "object" || value.type !== "tool-recipe" || !states.includes(value.state) ||
      typeof value.name !== "string" || !value.name.trim() ||
      typeof value.purpose !== "string" || !value.purpose.trim()) return null;

  let steps;
  try {
    steps = parseSteps(value.steps);
  } catch {
    return null;
  }
  const applicability = typeof value.applicability === "string" ? value.applicability.trim() : "";
  if (applicability.length > 400 || value.name.trim().length > 80 || value.purpose.trim().length > 600) return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    type: "tool-recipe",
    state: value.state,
    name: value.name.trim().slice(0, 80),
    purpose: value.purpose.trim().slice(0, 600),
    applicability: applicability.slice(0, 400),
    steps,
    toolRefs: [...new Set(steps.map(step => step.toolRef))],
    ...(Array.isArray(value.sourceRefs) ? { sourceRefs: value.sourceRefs.filter(ref => typeof ref === "string" && ref.length > 0)
      .slice(0, 24).map(ref => ref.slice(0, 240)) } : {}),
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `knowledge:${item.key}` } : {}),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
  };
}

export function prepareToolRecipeEdit(current, {
  name: nameInput, purpose: purposeInput, applicability: applicabilityInput, steps: stepsInput,
} = {}, updatedAt = Date.now()) {
  const name = typeof nameInput === "string" ? nameInput.trim() : "";
  const purpose = typeof purposeInput === "string" ? purposeInput.trim() : "";
  const applicability = typeof applicabilityInput === "string" ? applicabilityInput.trim() : "";
  if (!name || name.length > 80 || !purpose || purpose.length > 600 || applicability.length > 400) {
    throw new Error("配方名称、用途或适用条件为空或超出长度限制。");
  }
  const steps = parseSteps(stepsInput);
  const currentRevision = Number(current?.revision);
  const revision = Number.isSafeInteger(currentRevision) && currentRevision > 0 ? currentRevision : 0;
  return {
    ...current,
    schemaVersion: 1,
    type: "tool-recipe",
    state: current?.state === "inactive" ? "inactive" : "active",
    name,
    purpose,
    applicability,
    steps,
    toolRefs: [...new Set(steps.map(step => step.toolRef))],
    revision: revision + 1,
    updatedAt,
  };
}

export function prepareToolRecipeState(current, state, updatedAt = Date.now()) {
  if (!current || current.type !== "tool-recipe" || !["active", "inactive"].includes(state)) {
    throw new Error("工具配方状态无效。");
  }
  const currentRevision = Number(current.revision);
  const revision = Number.isSafeInteger(currentRevision) && currentRevision > 0 ? currentRevision : 0;
  return { ...current, state, revision: revision + 1, updatedAt };
}
