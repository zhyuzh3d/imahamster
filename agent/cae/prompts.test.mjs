import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "./prompts.mjs";
import { IDENTITY_CORE } from "../sm/identity-core.mjs";

test("CAE composes its stable action policy with the immutable Identity Core", () => {
  assert.equal(typeof IDENTITY_CORE, "string");
  assert.equal(IDENTITY_CORE, "你是 ImHamster 的手机智能体代理。");
  assert.ok(SYSTEM_PROMPT.startsWith(IDENTITY_CORE));
  assert.match(SYSTEM_PROMPT, /任务是否完成由你根据用户目标、操作历史和当前最终状态自行判断/);
  assert.match(SYSTEM_PROMPT, /严格输出 JSON/);
});
