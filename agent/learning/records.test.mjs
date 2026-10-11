import test from "node:test";
import assert from "node:assert/strict";
import { prepareLearningRecords } from "./records.mjs";

const sourceRef = "trace:ost-1:100:4:decision";
const history = [{ sourceRef, at: 100, phase: "decision" }];

test("learning preparation creates trace-backed ME, BP, experience, and bounded TE records", () => {
  const result = prepareLearningRecords({
    savePattern: true,
    pattern: { title: "表达简洁", condition: "回复朋友消息", guidance: "自然简短", evidence: "用户采用" },
    saveExperience: true,
    experience: { title: "先观察", situation: "处理新消息", approach: "核实联系人后回复", successEvidence: "发送后出现消息气泡", toolRefs: ["interaction.capture", "shell.exec"] },
    saveMemory: true,
    memories: [{ kind: "fact", objectRefs: ["contact:Zhang"], content: "习惯在周末讨论徒步。", inference: "observed", tags: ["徒步"], sourceRefs: [sourceRef] }],
    saveRecipe: true,
    recipe: { name: "核对会话再回复", purpose: "结合消息上下文回复", applicability: "联系人明确", sourceRefs: ["trace:unrelated" , sourceRef], steps: [
      { toolRef: "interaction.capture", purpose: "核对联系人和新消息" },
      { toolRef: "interaction.inputText", purpose: "输入已经确认的回复" },
    ] },
    saveTool: true,
    tool: { name: "历史候选", description: "只作为流程说明", toolRefs: ["interaction.tap", "shell.exec"] },
  }, { goalId: "ost-1", progress: "LLM 判断目标已完成", history, now: 200 });

  const byKey = new Map(result.records.map(item => [item.key, item]));
  assert.deepEqual(result.skipped, []);
  assert.equal(byKey.get("bp:ost-1").value.type, "behavior-pattern");
  assert.deepEqual(byKey.get("experience:ost-1").value.toolRefs, ["interaction.capture"]);
  assert.deepEqual(byKey.get("memory:ost-1:1").value.sourceRefs, [sourceRef]);
  assert.deepEqual(byKey.get("tool-recipe:ost-1").value.sourceRefs, [sourceRef]);
  assert.deepEqual(byKey.get("tool-recipe:ost-1").value.toolRefs, ["interaction.capture", "interaction.inputText"]);
  assert.deepEqual(byKey.get("tool-candidate:ost-1").value.toolRefs, ["interaction.tap"]);
  assert.ok(result.records.every(item => !item.key.includes("identity-core")));
});

test("an invalid recipe is skipped without losing other useful learning records", () => {
  const result = prepareLearningRecords({
    saveRecipe: true,
    recipe: { name: "无来源", purpose: "无来源不可保存", sourceRefs: ["trace:forged"], steps: [
      { toolRef: "interaction.tap", purpose: "点击" }, { toolRef: "interaction.capture", purpose: "观察" },
    ] },
    saveMemory: true,
    memories: [{ kind: "episode", objectRefs: ["contact:Alice"], content: "提到下周见面。", inference: "observed", tags: [], sourceRefs: [sourceRef] }],
  }, { goalId: "ost-2", progress: "完成", history, now: 300 });

  assert.equal(result.records.some(item => item.key === "tool-recipe:ost-2"), false);
  assert.equal(result.records.some(item => item.key === "memory:ost-2:1"), true);
  assert.match(result.skipped[0], /有效任务轨迹来源/);
});
