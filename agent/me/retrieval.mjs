const EXPERIENCE_FIELDS = ["title", "situation", "approach", "successEvidence"];
const STOP_TOKENS = new Set(["这个", "一个", "当前", "任务", "用户", "帮我", "需要", "相关", "进行", "处理", "操作", "自动"]);

function tokens(text) {
  const normalized = String(text || "").normalize("NFKC").toLowerCase();
  const result = new Set(normalized.match(/[a-z0-9]+/g) || []);
  const hanRuns = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of hanRuns) {
    const chars = Array.from(run);
    if (chars.length === 1) result.add(chars[0]);
    for (let index = 0; index + 1 < chars.length; index += 1) result.add(chars[index] + chars[index + 1]);
  }
  for (const token of STOP_TOKENS) result.delete(token);
  return result;
}

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
    ...fields,
    toolRefs,
    ...(Number.isFinite(Number(value.createdAt)) ? { createdAt: Number(value.createdAt) } : {}),
  };
}

/** Rank active, validated experiences against the current user goal. */
export function retrieveRelevantExperiences(intent, items, { limit = 5 } = {}) {
  if (typeof intent !== "string" || !Array.isArray(items) || !Number.isInteger(limit) || limit < 0) {
    throw new TypeError("ME 经验检索参数无效");
  }
  const query = tokens(intent);
  if (!query.size || limit === 0) return [];

  return items.map((item, index) => {
    const value = experienceValue(item);
    if (!value) return null;
    const document = tokens(EXPERIENCE_FIELDS.map(field => value[field]).join(" "));
    let score = 0;
    for (const token of query) if (document.has(token)) score += 1;
    if (!score) return null;
    return { value, score, index };
  }).filter(Boolean)
    .sort((left, right) => right.score - left.score ||
      Number(right.value.createdAt || 0) - Number(left.value.createdAt || 0) || left.index - right.index)
    .slice(0, limit)
    .map(item => item.value);
}
