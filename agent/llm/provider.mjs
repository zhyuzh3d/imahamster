const DEFAULT_CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 55_000;

export function buildChatCompletionRequest(provider, messages, { timeoutMs = DEFAULT_TIMEOUT_MS, userAgent = false } = {}) {
  const baseUrl = String(provider?.baseUrl || "").replace(/\/+$/, "");
  const endpointPath = provider?.endpointPath || DEFAULT_CHAT_COMPLETIONS_PATH;
  if (!/^https:\/\//i.test(baseUrl) || !/^\/[A-Za-z0-9._/-]+$/.test(endpointPath)) {
    throw new TypeError("模型服务地址无效");
  }
  if (typeof provider?.apiKey !== "string" || !provider.apiKey || typeof provider?.model !== "string" || !provider.model) {
    throw new TypeError("模型服务配置不完整");
  }
  const headers = { Authorization: `Bearer ${provider.apiKey}`, Accept: "application/json" };
  if (userAgent) headers["User-Agent"] = "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
  return {
    url: `${baseUrl}${endpointPath}`,
    method: "POST",
    headers,
    contentType: "application/json",
    bodyText: JSON.stringify({ model: provider.model, messages }),
    timeoutMs,
  };
}

export function readProviderResponse(response) {
  if (typeof response?.bodyText === "string" && response.bodyText) {
    return { kind: "text", text: response.bodyText };
  }
  if (response?.file?.logicalFileId) {
    return { kind: "file", logicalFileId: response.file.logicalFileId };
  }
  throw new Error("模型响应没有可读正文");
}

export function parseChatCompletionContent(responseText, purpose = "模型") {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`${purpose}响应不是有效 JSON：${String(error?.message || error).slice(0, 160)}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${purpose}响应中没有可读正文`);
  return content;
}

export function classifyProviderStatus(status) {
  const code = Number(status) || 0;
  const retryable = code === 408 || code === 429 || code >= 500;
  return { retryable, category: retryable ? "model-temporary" : "model-configuration" };
}
