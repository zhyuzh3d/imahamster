import test from "node:test";
import assert from "node:assert/strict";
import { formatMemoryContent, prepareExperienceEdit, prepareMemoryEdit } from "./memory.mjs";

test("memory edits preserve evidence metadata and advance the app revision", () => {
  const current = { id: "memory:contact-a", content: "旧内容", objectRefs: ["contact:A"], revision: 3,
    sourceRefs: ["trace:goal:1:1:decision"], inference: "observed", createdAt: 10 };
  const result = prepareMemoryEdit(current, "  新内容  ", "contact:A, contact:B, contact:A", 20);
  assert.equal(result.content, "新内容");
  assert.deepEqual(result.objectRefs, ["contact:A", "contact:B"]);
  assert.equal(result.revision, 4);
  assert.equal(result.updatedAt, 20);
  assert.deepEqual(result.sourceRefs, current.sourceRefs);
  assert.equal(result.inference, "observed");
});

test("memory edits reject empty, oversized, or unscoped changes", () => {
  const current = { content: "old", objectRefs: ["contact:A"], revision: 1 };
  assert.throws(() => prepareMemoryEdit(current, " ", "contact:A"), /记忆内容/);
  assert.throws(() => prepareMemoryEdit(current, "x".repeat(801), "contact:A"), /记忆内容/);
  assert.throws(() => prepareMemoryEdit(current, "new", ""), /对象范围/);
  assert.throws(() => prepareMemoryEdit(current, "new", Array.from({ length: 9 }, (_, index) => "contact:" + index).join(",")), /对象范围/);
  assert.throws(() => prepareMemoryEdit(current, "new", "x".repeat(121)), /对象范围/);
});

test("experience Memory edits preserve evidence and advance their revision", () => {
  const current = { type: "experience", state: "active", title: "旧标题", situation: "旧情境", approach: "旧做法",
    successEvidence: "旧结果", toolRefs: ["interaction.tap"], sourceGoalId: "goal-1", createdAt: 10, revision: 2 };
  const result = prepareExperienceEdit(current, {
    title: " 新标题 ", situation: " 新情境 ", approach: " 新做法 ", successEvidence: " 新结果 ",
    toolRefs: "interaction.capture, interaction.tap, interaction.capture",
  }, 20);
  assert.equal(result.type, "experience");
  assert.equal(result.title, "新标题");
  assert.deepEqual(result.toolRefs, ["interaction.capture", "interaction.tap"]);
  assert.equal(result.revision, 3);
  assert.equal(result.updatedAt, 20);
  assert.equal(result.sourceGoalId, "goal-1");
});

test("experience Memory edits reject missing fields and unregistered tools", () => {
  const base = { title: "标题", situation: "情境", approach: "做法", successEvidence: "依据", toolRefs: "interaction.tap" };
  assert.throws(() => prepareExperienceEdit(null, { ...base, title: " " }), /经验需要标题/);
  assert.throws(() => prepareExperienceEdit(null, { ...base, situation: "x".repeat(801) }), /经验需要标题/);
  assert.throws(() => prepareExperienceEdit(null, { ...base, toolRefs: "shell.exec" }), /已注册工具/);
  assert.throws(() => prepareExperienceEdit(null, { ...base,
    toolRefs: Array(9).fill("interaction.tap").map((value, index) => `${value}, interaction.swipe${index}`).join(","),
  }), /已注册工具/);
});

test("Memory panel content formatter exposes experience method and evidence", () => {
  assert.equal(formatMemoryContent({ type: "memory", content: "一条事实" }), "一条事实");
  assert.equal(formatMemoryContent({ type: "experience", situation: "微信新消息", approach: "核对对象后回复",
    successEvidence: "消息气泡出现", toolRefs: ["interaction.capture", "interaction.tap"] }),
  "适用情境：微信新消息\n处理做法：核对对象后回复\n结果依据：消息气泡出现\n工具：interaction.capture、interaction.tap");
});
