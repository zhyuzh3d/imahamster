import test from "node:test";
import assert from "node:assert/strict";
import { validateScreenAction } from "./decision.mjs";

test("explicitly scoped friend actions are valid when the visible recipient is identified", () => {
  const action = { type: "tap", target: "添加好友", label: "添加", x: 0.5, y: 0.4,
    effect: "friend-add", visibleTarget: "zhyuzh" };
  assert.equal(validateScreenAction(action), action);
});

test("message effects require visible recipient, full content, and the confirming button", () => {
  const action = { type: "tap", target: "发送", label: "发送", x: 0.9, y: 0.95,
    effect: "send", visibleTarget: "zhyuzh", visibleContent: "合成测试消息" };
  assert.equal(validateScreenAction(action), action);
  assert.throws(() => validateScreenAction({ ...action, visibleContent: "" }), /完整内容/);
});

test("destructive and permission effects remain blocked by the Worker action contract", () => {
  for (const effect of ["delete", "purchase", "permission"]) {
    assert.throws(() => validateScreenAction({ type: "tap", target: "确认", x: 0.5, y: 0.5, effect }), /高影响动作/);
  }
});

test("input actions can target the visible editor and reject partial or out-of-range coordinates", () => {
  const action = { type: "input", target: "消息输入框", focused: true, mode: "replace", text: "synthetic", x: 0.4, y: 0.9 };
  assert.equal(validateScreenAction(action), action);
  assert.throws(() => validateScreenAction({ ...action, y: undefined }), /输入框坐标/);
  assert.throws(() => validateScreenAction({ ...action, x: 1.1 }), /输入框坐标/);
});
