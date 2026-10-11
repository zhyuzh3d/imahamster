import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBehaviorPattern, retrieveBehaviorPatterns } from "./behavior-patterns.mjs";

const pattern = (title, condition, guidance, createdAt = 0, extra = {}) => ({ value: {
  type: "behavior-pattern", state: "active", scope: "global", title, condition, guidance,
  evidence: "多次任务中用户明确采用此方式", createdAt, ...extra,
} });

test("SM retrieves matching global behavior patterns and excludes memories or untrusted states", () => {
  const items = [
    pattern("简洁友好回复", "回复微信朋友消息", "用自然、简短、友好的语气", 1),
    pattern("天气查询", "查看天气预报", "优先查看本地天气", 2),
    pattern("不活跃模式", "回复微信消息", "遵循旧模式", 9, { state: "inactive" }),
    { value: { type: "experience", state: "active", scope: "global", title: "微信经验", condition: "回复", guidance: "操作" } },
    pattern("应用专属模式", "回复微信消息", "应用私有指导", 10, { scope: "app" }),
  ];

  const result = retrieveBehaviorPatterns("回复微信朋友消息", items);

  assert.deepEqual(result.map(item => item.title), ["简洁友好回复"]);
  assert.equal("sourceGoalId" in result[0], false);
});

test("SM normalizes learned patterns to bounded global preference records", () => {
  const value = normalizeBehaviorPattern({
    title: "简洁回复", condition: "给朋友回消息", guidance: "表达自然，不必复述对方原文",
    evidence: "该表达方式已经用于成功任务", ignoredCode: "console.log(1)",
  }, { sourceGoalId: "goal-1", at: 100 });

  assert.deepEqual(value, {
    schemaVersion: 1, type: "behavior-pattern", state: "active", scope: "global",
    title: "简洁回复", condition: "给朋友回消息", guidance: "表达自然，不必复述对方原文",
    evidence: "该表达方式已经用于成功任务", sourceGoalId: "goal-1", createdAt: 100,
  });
  assert.equal(normalizeBehaviorPattern({ title: "x" }, { sourceGoalId: "goal-1" }), null);
});

test("SM does not retrieve patterns without matching concepts or from malformed collections", () => {
  assert.deepEqual(retrieveBehaviorPatterns("打开相机", [pattern("回复偏好", "回复消息", "简洁")]), []);
  assert.throws(() => retrieveBehaviorPatterns("回复", "not-an-array"), /参数无效/);
  assert.throws(() => retrieveBehaviorPatterns("回复", [], { limit: -1 }), /参数无效/);
});
