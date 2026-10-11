import { keywordOverlapScore, tokenizeKeywords } from "../shared/keywords.mjs";

const MEMORY_KINDS = new Set(["fact", "episode"]);
const INFERENCE_TYPES = new Set(["observed", "inferred"]);

function uniqueStrings(values, { limit, maxLength, allowed = null } = {}) {
  if (!Array.isArray(values)) return [];
  const output = [];
  const seen = new Set();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    const value = raw.trim().slice(0, maxLength);
    if (!value || (allowed && !allowed.has(value)) || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

/** Stable pointer from a learning suggestion to one saved OST trace entry. */
export function memorySourceRef(goalId, event) {
  if (typeof goalId !== "string" || !goalId || !event || typeof event !== "object") return "";
  const at = Number(event.at);
  const step = Number(event.step);
  const phase = String(event.phase || "").trim();
  if (!Number.isFinite(at) || !Number.isFinite(step) || !phase) return "";
  return `trace:${goalId.slice(0, 120)}:${Math.floor(at)}:${Math.floor(step)}:${phase.slice(0, 48)}`;
}

/** Validate an LLM-proposed compact memory against the trace references shown to it. */
export function normalizeMemorySuggestion(item, { goalId, allowedSourceRefs, sourceTimes = {}, at = Date.now() } = {}) {
  if (!item || typeof item !== "object" || !MEMORY_KINDS.has(item.kind)) return null;
  if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 800) return null;
  if (!INFERENCE_TYPES.has(item.inference)) return null;
  if (typeof goalId !== "string" || !goalId) return null;

  const objectRefs = uniqueStrings(item.objectRefs, { limit: 8, maxLength: 120 });
  if (!objectRefs.length) return null;
  const allowed = allowedSourceRefs instanceof Set ? allowedSourceRefs : new Set();
  const sourceRefs = uniqueStrings(item.sourceRefs, { limit: 8, maxLength: 240, allowed });
  if (!sourceRefs.length) return null;

  const observedAt = Math.max(0, ...sourceRefs.map(ref => Number(sourceTimes[ref]) || 0));
  const tags = uniqueStrings(item.tags, { limit: 12, maxLength: 40 });
  return {
    schemaVersion: 1,
    type: "memory",
    kind: item.kind,
    state: "active",
    objectRefs,
    content: item.content.trim(),
    sourceRefs,
    observedAt: observedAt || at,
    inference: item.inference,
    tags,
    sourceGoalId: goalId.slice(0, 120),
    revision: 1,
    createdAt: at,
  };
}

function storedMemory(item) {
  const value = item?.value || item;
  if (!value || typeof value !== "object" || value.type !== "memory" || value.state !== "active" ||
      !MEMORY_KINDS.has(value.kind) || !INFERENCE_TYPES.has(value.inference) ||
      typeof value.content !== "string" || !value.content.trim()) return null;
  const objectRefs = uniqueStrings(value.objectRefs, { limit: 8, maxLength: 120 });
  const sourceRefs = uniqueStrings(value.sourceRefs, { limit: 8, maxLength: 240 });
  if (!objectRefs.length || !sourceRefs.length) return null;
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    type: "memory",
    kind: value.kind,
    state: "active",
    objectRefs,
    content: value.content.trim().slice(0, 800),
    sourceRefs,
    observedAt: Number(value.observedAt) || 0,
    inference: value.inference,
    tags: uniqueStrings(value.tags, { limit: 12, maxLength: 40 }),
    id: String(value.id || item?.key || "").slice(0, 160),
    revision: Math.max(1, Number(value.revision) || 1),
    ...(typeof item?.key === "string" && item.key ? { sourceRef: `knowledge:${item.key}` } : {}),
    ...(item?.revision !== undefined ? { recordRevision: String(item.revision).slice(0, 80) } : {}),
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
  };
}

/** Retrieve bounded object memories relevant to the current OST, without source-private metadata. */
export function retrieveRelevantMemories(intent, items, { limit = 5 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("ME 记忆检索参数无效");
  }
  const normalizedIntent = intent.normalize("NFKC").toLowerCase();
  if (!normalizedIntent.trim() || limit === 0) return [];
  const query = tokenizeKeywords(intent);
  const contentOverlap = text => keywordOverlapScore(query, tokenizeKeywords(text));
  const ranked = items.map((item, index) => {
    const value = storedMemory(item);
    if (!value) return null;
    const matchedObjectRefs = value.objectRefs.filter(ref => {
      const label = ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref;
      return label.length >= 2 && normalizedIntent.includes(label.normalize("NFKC").toLowerCase());
    });
    const globalScope = value.objectRefs.some(ref => /^(self|general):/i.test(ref));
    const contentScore = contentOverlap([value.content, ...value.tags].join(" "));
    if (matchedObjectRefs.length) return { value, score: 10 + contentScore, index };
    if (globalScope && contentScore) return { value, score: contentScore, index };
    return null;
  }).filter(Boolean)
  return ranked.sort((left, right) => right.score - left.score || right.value.observedAt - left.value.observedAt || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}

/** Load only memories whose object reference was explicitly requested by the model. */
export function retrieveMemoriesForObjects(objectRefs, items, { limit = 5 } = {}) {
  if (!Array.isArray(objectRefs) || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("ME 对象记忆参数无效");
  }
  const requested = new Set(uniqueStrings(objectRefs, { limit: 8, maxLength: 120 }));
  if (!requested.size || limit === 0) return [];
  return items.map((item, index) => {
    const value = storedMemory(item);
    if (!value || !value.objectRefs.some(ref => requested.has(ref))) return null;
    return { value, index };
  }).filter(Boolean)
    .sort((left, right) => right.value.observedAt - left.value.observedAt || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}
