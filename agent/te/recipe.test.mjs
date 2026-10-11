import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolRecipeRecord, prepareToolRecipeEdit, prepareToolRecipeState } from "./recipe.mjs";
import { retrieveRelevantToolRecipes } from "./recipe-retrieval.mjs";

const steps = [
  { toolRef: "interaction.capture", purpose: "观察当前会话和消息" },
  { toolRef: "interaction.inputText", purpose: "在核实输入框后输入拟定正文" },
  { toolRef: "interaction.capture", purpose: "发送前核对对象和正文" },
];

test("TE normalizes bounded recipes and preserves only registered ordered steps", () => {
  const recipe = normalizeToolRecipeRecord({ key: "tool-recipe:g1", revision: "7", value: {
    type: "tool-recipe", state: "active", name: "核对后回复", purpose: "按当前会话上下文回复消息",
    applicability: "适用于明确指定的聊天会话", steps, sourceRefs: ["trace:g1:1"], createdAt: 30,
  } });
  assert.deepEqual(recipe.steps, steps);
  assert.deepEqual(recipe.toolRefs, ["interaction.capture", "interaction.inputText"]);
  assert.equal(recipe.sourceRef, "knowledge:tool-recipe:g1");
  assert.equal(recipe.recordRevision, "7");
  assert.equal(normalizeToolRecipeRecord({ value: { ...recipe, state: "inactive" } }), null);
  assert.equal(normalizeToolRecipeRecord({ value: { ...recipe, state: "inactive" } }, { includeInactive: true })?.state, "inactive");
  assert.equal(normalizeToolRecipeRecord({ value: { ...recipe, steps: [{ toolRef: "shell.exec", purpose: "run code" }] } }), null);
});

test("TE recipe edits enforce step count, registered tools, and revision provenance", () => {
  const current = { type: "tool-recipe", state: "active", revision: 3, sourceGoalId: "g2" };
  const edited = prepareToolRecipeEdit(current, {
    name: " 新名称 ", purpose: " 新用途 ", applicability: "明确场景", steps: JSON.stringify(steps),
  }, 40);
  assert.equal(edited.name, "新名称");
  assert.equal(edited.revision, 4);
  assert.equal(edited.updatedAt, 40);
  assert.equal(edited.sourceGoalId, "g2");
  assert.throws(() => prepareToolRecipeEdit(current, {
    name: "配方", purpose: "用途", steps: [{ toolRef: "shell.exec", purpose: "运行脚本" }],
  }), /2–8 个有序步骤/);
  assert.throws(() => prepareToolRecipeEdit(current, {
    name: "配方", purpose: "用途", steps: [{ toolRef: "interaction.tap", purpose: "点击" }, { toolRef: "shell.exec", purpose: "运行脚本" }],
  }), /已注册工具/);
  assert.equal(prepareToolRecipeState(edited, "inactive", 50).state, "inactive");
});

test("TE retrieves relevant bounded recipes and excludes inactive or unrelated records", () => {
  const items = [
    { key: "tool-recipe:wx", revision: 2, value: { type: "tool-recipe", state: "active", name: "微信消息回复", purpose: "核对联系人和上下文后回复", steps, createdAt: 20 } },
    { value: { type: "tool-recipe", state: "active", name: "天气查询", purpose: "查看天气预报", steps, createdAt: 30 } },
    { value: { type: "tool-recipe", state: "inactive", name: "旧微信回复", purpose: "核对微信消息后回复", steps, createdAt: 40 } },
  ];
  const found = retrieveRelevantToolRecipes("结合微信上下文回复消息", items, { limit: 1 });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "微信消息回复");
  assert.equal(found[0].recordRevision, "2");
  assert.deepEqual(retrieveRelevantToolRecipes("打开相机", items), []);
  assert.throws(() => retrieveRelevantToolRecipes("消息", [], { limit: -1 }), /参数无效/);
});
