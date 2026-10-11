import test from "node:test";
import assert from "node:assert/strict";
import { prepareMemoryEdit } from "./self-model.mjs";

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
