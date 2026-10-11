import test from "node:test";
import assert from "node:assert/strict";
import { prepareBehaviorPatternEdit, prepareBehaviorPatternStatus } from "./behavior-patterns.mjs";

test("BP edits preserve provenance and constrain each field to its contract", () => {
  const current = { type: "behavior-pattern", state: "active", scope: "global", title: "旧", condition: "旧场景",
    guidance: "旧建议", evidence: "旧依据", sourceGoalId: "goal-1", createdAt: 10, revision: 2 };
  const result = prepareBehaviorPatternEdit(current, { title: "简洁交流", condition: "回复熟人", guidance: "先回应重点", evidence: "三个成功任务" }, 20);
  assert.equal(result.title, "简洁交流");
  assert.equal(result.sourceGoalId, "goal-1");
  assert.equal(result.createdAt, 10);
  assert.equal(result.revision, 3);
  assert.equal(result.updatedAt, 20);
  assert.throws(() => prepareBehaviorPatternEdit(current, { title: "", condition: "x", guidance: "x", evidence: "x" }), /名称不能为空/);
  assert.throws(() => prepareBehaviorPatternEdit(current, { title: "x".repeat(121), condition: "x", guidance: "x", evidence: "x" }), /名称不能为空/);
});

test("BP deactivation is reversible and only updates lifecycle metadata", () => {
  const current = { type: "behavior-pattern", state: "active", scope: "global", title: "title", revision: 1 };
  const disabled = prepareBehaviorPatternStatus(current, "disabled", 20);
  assert.equal(disabled.state, "disabled");
  assert.equal(disabled.disabledAt, 20);
  assert.equal(disabled.revision, 2);
  const enabled = prepareBehaviorPatternStatus(disabled, "active", 30);
  assert.equal(enabled.state, "active");
  assert.equal(Object.hasOwn(enabled, "disabledAt"), false);
  assert.equal(enabled.revision, 3);
  assert.throws(() => prepareBehaviorPatternStatus(current, "deleted"), /BP 状态无效/);
});
