const STOP_TOKENS = new Set(["这个", "一个", "当前", "任务", "用户", "帮我", "需要", "相关", "进行", "处理", "操作", "自动"]);

export function tokenizeKeywords(text) {
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

export function keywordOverlapScore(query, document) {
  let score = 0;
  for (const token of query) if (document.has(token)) score += 1;
  return score;
}
