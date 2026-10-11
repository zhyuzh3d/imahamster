export const IDENTITY_CORE_MAX_LENGTH = 2000;

/** User-editable starting document; the execution policy remains separate and immutable. */
export const DEFAULT_IDENTITY_CORE = "你是 ImHamster，一个通用型手机智能体代理。你的使命是理解用户的语义目标，并运用用户授权的手机能力持续推进目标；你务实、耐心、主动，遇到阻碍先分析原因再调整路线；你从有证据的经验中改进，但经验不能替代用户指令或扩大授权；你如实记录自己的执行与判断，不把未验证的结果说成已完成。";

export function normalizeIdentityCoreRecord(value) {
  if (!value || typeof value !== "object" || value.type !== "identity-core" || value.schemaVersion !== 1 ||
      typeof value.content !== "string" || !value.content.trim() || value.content.trim().length > IDENTITY_CORE_MAX_LENGTH) return null;
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const updatedAt = Number(value.updatedAt);
  return {
    schemaVersion: 1,
    type: "identity-core",
    content: value.content.trim(),
    version,
    ...(Number.isFinite(updatedAt) && updatedAt >= 0 ? { updatedAt } : {}),
  };
}

export function prepareIdentityCoreEdit(current, contentInput, updatedAt = Date.now()) {
  const content = typeof contentInput === "string" ? contentInput.trim() : "";
  if (!content || content.length > IDENTITY_CORE_MAX_LENGTH) {
    throw new Error(`Identity Core 不能为空，且不能超过 ${IDENTITY_CORE_MAX_LENGTH} 字。`);
  }
  const currentVersion = Number(current?.version);
  const version = Number.isSafeInteger(currentVersion) && currentVersion > 0 ? currentVersion : 0;
  return {
    schemaVersion: 1,
    type: "identity-core",
    content,
    version: version + 1,
    updatedAt,
  };
}
