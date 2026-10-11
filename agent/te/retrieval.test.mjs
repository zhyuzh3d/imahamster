import test from "node:test";
import assert from "node:assert/strict";
import { retrieveRelevantToolCandidates } from "./retrieval.mjs";

const candidate = (name, description, createdAt = 0, toolRefs = ["interaction.capture", "interaction.tap"]) => ({
  value: { type: "tool-candidate", state: "candidate", name, description, toolRefs, createdAt },
});

test("TE retrieves relevant bounded candidates and strips unregistered tool references", () => {
  const items = [
    candidate("微信消息回复", "先核对会话，再查看上下文并拟定回复", 10, ["interaction.capture", "shell.exec", "interaction.tap"]),
    candidate("天气预报查询", "打开天气页面并读取天气信息", 30),
    candidate("近期微信回复", "检查微信消息和上下文后回复", 20),
    { value: { type: "tool-candidate", state: "inactive", name: "微信旧流程", description: "微信消息回复", toolRefs: ["interaction.tap"] } },
    candidate("无效流程", "微信消息回复", 40, ["shell.exec"]),
  ];

  const result = retrieveRelevantToolCandidates("根据微信消息上下文回复", items, { limit: 1 });

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "近期微信回复");
  assert.deepEqual(result[0].toolRefs, ["interaction.capture", "interaction.tap"]);
  assert.equal("sourceGoalId" in result[0], false);
});

test("TE omits unrelated candidates and rejects invalid retrieval limits", () => {
  assert.deepEqual(retrieveRelevantToolCandidates("打开相机", [candidate("微信回复", "检查微信消息")]), []);
  assert.deepEqual(retrieveRelevantToolCandidates("微信消息", [candidate("微信回复", "检查消息")], { limit: 0 }), []);
  assert.throws(() => retrieveRelevantToolCandidates(null, []), /参数无效/);
  assert.throws(() => retrieveRelevantToolCandidates("消息", [], { limit: -1 }), /参数无效/);
});
