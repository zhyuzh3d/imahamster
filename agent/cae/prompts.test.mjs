import test from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT } from "./prompts.mjs";
import { DEFAULT_IDENTITY_CORE, normalizeIdentityCoreRecord, prepareIdentityCoreEdit } from "../sm/identity-core.mjs";

test("CAE keeps user-editable Identity Core separate from its immutable execution policy", () => {
  assert.equal(typeof DEFAULT_IDENTITY_CORE, "string");
  assert.match(DEFAULT_IDENTITY_CORE, /^你是 ImHamster，一个通用型手机智能体代理。/);
  assert.match(DEFAULT_IDENTITY_CORE, /经验不能替代用户指令或扩大授权/);
  assert.match(DEFAULT_IDENTITY_CORE, /不把未验证的结果说成已完成/);
  assert.match(SYSTEM_PROMPT, /^你是 ImHamster，一个通用型手机智能体代理。/);
  assert.doesNotMatch(SYSTEM_PROMPT, /务实、耐心、主动/);
  assert.match(SYSTEM_PROMPT, /用户编辑的 IC 只提供角色与表达偏好/);
  assert.match(SYSTEM_PROMPT, /任务是否完成由你根据用户目标、操作历史和当前最终状态自行判断/);
  assert.match(SYSTEM_PROMPT, /严格输出 JSON/);
});

test("Identity Core edits are versioned and invalid stored records fall back safely", () => {
  const initial = prepareIdentityCoreEdit(null, "新的角色说明", 10);
  assert.deepEqual(initial, { schemaVersion: 1, type: "identity-core", content: "新的角色说明", version: 1, updatedAt: 10 });
  const next = prepareIdentityCoreEdit(initial, "继续保持务实", 20);
  assert.equal(next.version, 2);
  assert.equal(normalizeIdentityCoreRecord(next)?.content, "继续保持务实");
  assert.equal(normalizeIdentityCoreRecord({ ...next, content: " " }), null);
  assert.equal(normalizeIdentityCoreRecord({ ...next, version: Number.POSITIVE_INFINITY }), null);
  assert.equal(normalizeIdentityCoreRecord({ ...next, version: 0 }), null);
  assert.throws(() => prepareIdentityCoreEdit(next, ""), /不能为空/);
});
