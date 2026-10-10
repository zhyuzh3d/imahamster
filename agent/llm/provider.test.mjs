import test from "node:test";
import assert from "node:assert/strict";
import { buildChatCompletionRequest, classifyProviderStatus, parseChatCompletionContent, readProviderResponse } from "./provider.mjs";

test("one provider adapter builds the same minimal request for each call purpose", () => {
  const provider = { baseUrl: "https://model.example/", apiKey: "secret-provider-key", model: "vision-model" };
  const request = buildChatCompletionRequest(provider, [{ role: "user", content: "hello" }]);
  assert.equal(request.url, "https://model.example/v1/chat/completions");
  assert.equal(request.timeoutMs, 55_000);
  assert.deepEqual(JSON.parse(request.bodyText), { model: "vision-model", messages: [{ role: "user", content: "hello" }] });
  assert.equal("User-Agent" in request.headers, false);
  assert.equal(buildChatCompletionRequest(provider, [], { userAgent: true }).headers["User-Agent"].startsWith("Mozilla/"), true);
});

test("provider response normalization supports inline and stored-file bodies", () => {
  assert.deepEqual(readProviderResponse({ bodyText: "{}" }), { kind: "text", text: "{}" });
  assert.deepEqual(readProviderResponse({ file: { logicalFileId: "response-1" } }), { kind: "file", logicalFileId: "response-1" });
  assert.equal(parseChatCompletionContent(JSON.stringify({ choices: [{ message: { content: "done" } }] })), "done");
  assert.throws(() => parseChatCompletionContent("{}", "AL 复盘"), /AL 复盘响应中没有可读正文/);
});

test("provider status classification isolates transport failures from configuration errors", () => {
  assert.deepEqual(classifyProviderStatus(429), { retryable: true, category: "model-temporary" });
  assert.deepEqual(classifyProviderStatus(503), { retryable: true, category: "model-temporary" });
  assert.deepEqual(classifyProviderStatus(401), { retryable: false, category: "model-configuration" });
});
