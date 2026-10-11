import test from "node:test";
import assert from "node:assert/strict";
import { memorySourceRef, normalizeMemorySuggestion, retrieveMemoriesForObjects, retrieveRelevantMemories } from "./memory.mjs";

const trace = { at: 100, step: 4, phase: "decision" };
const ref = memorySourceRef("goal-1", trace);

test("ME stores compact object memory with source-backed observed time and inference", () => {
  const allowed = new Set([ref]);
  const result = normalizeMemorySuggestion({
    kind: "episode", objectRefs: ["contact:小明", "contact:小明"], content: "小明提到下周想讨论旅行计划。",
    inference: "observed", tags: ["聊天", "旅行"], sourceRefs: [ref, "trace:other"],
  }, { goalId: "goal-1", allowedSourceRefs: allowed, sourceTimes: { [ref]: 100 }, at: 200 });

  assert.deepEqual(result, {
    schemaVersion: 1, type: "memory", kind: "episode", state: "active",
    objectRefs: ["contact:小明"], content: "小明提到下周想讨论旅行计划。", sourceRefs: [ref],
    observedAt: 100, inference: "observed", tags: ["聊天", "旅行"], sourceGoalId: "goal-1",
    revision: 1, createdAt: 200,
  });
});

test("ME rejects memories without a valid object, kind, inference, content or supplied source", () => {
  const base = { kind: "fact", objectRefs: ["contact:小明"], content: "喜欢旅行", inference: "inferred", sourceRefs: [ref] };
  const options = { goalId: "goal-1", allowedSourceRefs: new Set([ref]), at: 200 };
  assert.ok(normalizeMemorySuggestion(base, options));
  assert.equal(normalizeMemorySuggestion({ ...base, objectRefs: [] }, options), null);
  assert.equal(normalizeMemorySuggestion({ ...base, kind: "other" }, options), null);
  assert.equal(normalizeMemorySuggestion({ ...base, inference: "maybe" }, options), null);
  assert.equal(normalizeMemorySuggestion({ ...base, content: " " }, options), null);
  assert.equal(normalizeMemorySuggestion({ ...base, sourceRefs: ["trace:invented"] }, options), null);
  assert.equal(normalizeMemorySuggestion({ ...base, content: "x".repeat(801) }, options), null);
});

test("ME retrieves related active memories by object or content and excludes unrelated or private metadata", () => {
  const items = [
    { key: "memory:1", value: { type: "memory", kind: "fact", state: "active", objectRefs: ["contact:小明"], content: "喜欢徒步旅行", sourceRefs: [ref], observedAt: 100, inference: "observed", tags: ["旅行"], sourceGoalId: "private-goal" } },
    { key: "memory:2", value: { type: "memory", kind: "episode", state: "active", objectRefs: ["contact:小红"], content: "周末讨论旅行计划", sourceRefs: [ref], observedAt: 200, inference: "inferred", tags: ["旅行"] } },
    { key: "memory:3", value: { type: "memory", kind: "fact", state: "inactive", objectRefs: ["contact:小明"], content: "旧记忆", sourceRefs: [ref], inference: "observed" } },
    { key: "memory:4", value: { type: "memory", kind: "fact", state: "active", objectRefs: ["contact:小红"], content: "其他主题", sourceRefs: [], inference: "observed" } },
  ];
  const result = retrieveRelevantMemories("和小明聊旅行", items, { limit: 5 });
  assert.deepEqual(result.map(item => item.id), ["memory:1"]);
  assert.deepEqual(retrieveRelevantMemories("回复朋友关于旅行的消息", items), [], "contact memories must not leak across an unnamed object");
  assert.equal("sourceGoalId" in result[0], false);
  assert.deepEqual(result[0].sourceRefs, [ref]);
  assert.deepEqual(retrieveMemoriesForObjects(["contact:小红"], items).map(item => item.id), ["memory:2"]);
});

test("ME validates query and source reference parameters", () => {
  assert.equal(memorySourceRef("goal-1", trace), "trace:goal-1:100:4:decision");
  assert.equal(memorySourceRef("", trace), "");
  assert.throws(() => retrieveRelevantMemories(null, []), /参数无效/);
  assert.throws(() => retrieveRelevantMemories("任务", {}, {}), /参数无效/);
  assert.throws(() => retrieveRelevantMemories("任务", [], { limit: -1 }), /参数无效/);
});
