import { isRegisteredTool } from "./catalog.mjs";

function parseToolRefs(input) {
  const values = Array.isArray(input) ? input : String(input || "").split(/[,，\n]/);
  return [...new Set(values.map(value => String(value || "").trim()).filter(Boolean))];
}

/** Normalize a stored, non-executable workflow candidate for retrieval or management. */
export function normalizeToolCandidateRecord(item, { includeInactive = false } = {}) {
  const value = item?.value || item;
  const allowedStates = includeInactive ? ["candidate", "inactive"] : ["candidate"];
  if (!value || typeof value !== "object" || value.type !== "tool-candidate" || !allowedStates.includes(value.state) ||
      typeof value.name !== "string" || !value.name.trim() || typeof value.description !== "string" || !value.description.trim()) return null;
  const toolRefs = [...new Set((Array.isArray(value.toolRefs) ? value.toolRefs : []).filter(isRegisteredTool))].slice(0, 6);
  if (!toolRefs.length) return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    type: "tool-candidate",
    state: value.state,
    name: value.name.trim().slice(0, 80),
    description: value.description.trim().slice(0, 600),
    toolRefs,
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `knowledge:${item.key}` } : {}),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
  };
}

export function prepareToolCandidateEdit(current, {
  name: nameInput, description: descriptionInput, toolRefs: toolRefsInput,
} = {}, updatedAt = Date.now()) {
  const name = typeof nameInput === "string" ? nameInput.trim() : "";
  const description = typeof descriptionInput === "string" ? descriptionInput.trim() : "";
  const toolRefs = parseToolRefs(toolRefsInput);
  if (!name || name.length > 80 || !description || description.length > 600 || !toolRefs.length || toolRefs.length > 6 ||
      toolRefs.some(name => !isRegisteredTool(name))) {
    throw new Error("候选流程需要标题、说明和 1–6 个已注册工具引用，且必须符合长度限制。");
  }
  const currentRevision = Number(current?.revision);
  const revision = Number.isSafeInteger(currentRevision) && currentRevision > 0 ? currentRevision : 0;
  return {
    ...current,
    schemaVersion: 1,
    type: "tool-candidate",
    state: current?.state === "inactive" ? "inactive" : "candidate",
    name,
    description,
    toolRefs,
    revision: revision + 1,
    updatedAt,
  };
}

export function prepareToolCandidateState(current, state, updatedAt = Date.now()) {
  if (!current || current.type !== "tool-candidate" || !["candidate", "inactive"].includes(state)) {
    throw new Error("候选流程状态无效。");
  }
  const currentRevision = Number(current.revision);
  const revision = Number.isSafeInteger(currentRevision) && currentRevision > 0 ? currentRevision : 0;
  return { ...current, state, revision: revision + 1, updatedAt };
}
