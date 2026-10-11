import test from "node:test";
import assert from "node:assert/strict";
import { buildActionContext } from "./context.mjs";

test("CAE assembles a bounded action context without mutating the OST", () => {
  const state = {
    intent: "回复新消息",
    progress: "正在核对输入结果",
    step: 9,
    goalDeadlineAt: 10 * 60_000,
    actionLoop: { index: 2, budgetMinutes: 15 },
    actionLoopHistory: Array.from({ length: 8 }, (_, index) => ({ index, status: "reviewed", strategy: `路线 ${index}` })),
    trace: Array.from({ length: 24 }, (_, index) => ({ step: index, phase: `phase-${index}`, message: "异常".repeat(100) })),
    experiences: Array.from({ length: 7 }, (_, index) => ({ title: `经验 ${index}`, situation: "收消息", approach: "观察", successEvidence: "气泡可见" })),
    memories: Array.from({ length: 7 }, (_, index) => ({ id: `memory:${index}`, kind: "fact", objectRefs: ["contact:小明"], content: `小明记忆 ${index}`, sourceRefs: [`trace:${index}`], inference: "observed", tags: ["朋友"], revision: 1 })),
    memoryLookupRefs: ["contact:小明"],
    behaviorPatterns: Array.from({ length: 7 }, (_, index) => ({ title: `模式 ${index}`, condition: "回复消息", guidance: "简洁", evidence: "用户明确选择" })),
    toolCandidates: Array.from({ length: 5 }, (_, index) => ({ name: `候选 ${index}`, description: "仅提供参考", toolRefs: ["interaction.tap"] })),
    pendingOperationId: "op-1",
    pendingOperation: { operationId: "op-1", status: "unknown", intendedContent: "你好".repeat(5000) },
    inputRecovery: { stage: "focus-required", code: "E_CONFLICT" },
  };
  const before = structuredClone(state);

  const context = buildActionContext(state, { now: 5 * 60_000, actionLoopElapsedMs: 120_000,
    identityCore: { content: "我的表达偏好", version: 4 } });

  assert.match(context, /OST 硬时限剩余 5 分钟/);
  assert.match(context, /当前 AL 2，已用 2 分钟/);
  assert.match(context, /输入故障恢复/);
  assert.match(context, /待核实操作/);
  assert.match(context, /经验 0/);
  assert.doesNotMatch(context, /经验 5/);
  assert.match(context, /小明记忆 0/);
  assert.doesNotMatch(context, /小明记忆 5/);
  assert.match(context, /sourceRefs/);
  assert.match(context, /已查询过的对象记忆范围/);
  assert.match(context, /模式 0/);
  assert.doesNotMatch(context, /模式 5/);
  assert.match(context, /候选 0/);
  assert.match(context, /Identity Core（版本 4/);
  assert.match(context, /我的表达偏好/);
  assert.doesNotMatch(context, /候选 3/);
  assert.match(context, /仅是历史参考文本/);
  assert.doesNotMatch(context, /phase-0\"/);
  assert.match(context, /phase-4\"/);
  assert.match(context, /phase-23\"/);
  assert.equal(context.length < 16_000, true);
  assert.deepEqual(state, before);
});

test("CAE represents missing experience and action history explicitly", () => {
  const context = buildActionContext({ intent: "打开设置", goalDeadlineAt: 60_000 }, { now: 0 });
  assert.match(context, /暂无已验证的相关经验/);
  assert.match(context, /暂无相关的工具流程候选/);
  assert.match(context, /近期操作记录：\[\]/);
  assert.doesNotMatch(context, /此前 AL 记录：/);
  assert.match(context, /OST 硬时限剩余 1 分钟/);
  assert.doesNotMatch(context, /用户编辑的 Identity Core/);
});

test("CAE rejects absent runtime state instead of silently assembling empty context", () => {
  assert.throws(() => buildActionContext(null), /OST 状态/);
});
