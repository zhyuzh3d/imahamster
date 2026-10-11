import test from "node:test";
import assert from "node:assert/strict";
import { eventReceiptKey } from "./ho/events.mjs";
import { notificationInboxKey, timerInboxKey } from "./ho/edts.mjs";
import { memorySourceRef } from "./me/memory.mjs";
import "./worker.mjs";

let mockStoreRevision = 0;
function mockBatchResult(params) {
  return { results: (params?.operations || []).map(operation => operation.op === "delete"
    ? { op: "delete", key: operation.key, deleted: false }
    : { op: "put", key: operation.key, revision: `mock-r${++mockStoreRevision}` }) };
}

function persistMockBatch(records, params) {
  const result = mockBatchResult(params);
  params.operations.forEach((operation, index) => {
    const key = `${operation.collection}:${operation.key}`;
    if (operation.op === "delete") records.delete(key);
    else records.set(key, { value: structuredClone(operation.value), revision: result.results[index].revision });
  });
  return result;
}

test("a goal-registration CAS conflict queues its original intent behind the latest durable goal", () => {
  const started = globalThis.onHaminnEvent({ type: "start" });
  assert.equal(started.actions[0].method, "data.get");
  const idle = globalThis.onHaminnEvent({ type: "tool.result", callId: started.actions[0].callId,
    ok: true, result: null });
  assert.equal(idle.state, "idle");

  const submitted = globalThis.onHaminnEvent({ type: "goal.submit", intent: "合成 CAS 冲突恢复测试" });
  const initialActiveWrite = submitted.actions[0].params.operations.find(operation =>
    operation.collection === "agent-runtime" && operation.key === "active-goal");
  assert.equal(initialActiveWrite.expectedRevision, "absent");

  const reload = globalThis.onHaminnEvent({ type: "tool.result", callId: submitted.actions[0].callId,
    ok: false, error: { code: "E_CONFLICT", message: "revision changed" } });
  assert.equal(reload.actions[0].method, "data.get");
  assert.deepEqual(reload.actions[0].params, { collection: "agent-runtime", key: "active-goal" });

  const latest = {
    schemaVersion: 1, goalId: "goal-latest", taskId: "task-latest", runId: "run-latest",
    intent: "持久化中的较新目标", taskType: "one-shot", taskKind: "OST", state: "paused",
    revision: 7, progress: "用户已暂停", waiting: null, trace: [], journalSequence: 0,
    createdAt: 100, goalAttemptStartedAt: 100, goalDeadlineAt: 1_800_100,
  };
  const saved = globalThis.onHaminnEvent({ type: "tool.result", callId: reload.actions[0].callId,
    ok: true, result: { collection: "agent-runtime", key: "active-goal", value: latest, revision: "host-r9" } });
  assert.equal(saved.actions[0].method, "data.put");
  assert.equal(saved.actions[0].params.collection, "inbox");
  assert.equal(saved.actions[0].params.value.intent, "合成 CAS 冲突恢复测试");
  assert.equal(saved.actions[0].params.value.state, "queued");

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });
});

test("a goal-registration CAS conflict preserves the submitted intent and queues it behind a concurrent OST", () => {
  const records = new Map();
  const submittedIntent = "并发时也不能丢失的合成用户目标";
  const eventId = "goal-registration-cas-submit";

  const started = globalThis.onHaminnEvent({ type: "start" });
  const idle = globalThis.onHaminnEvent({ type: "tool.result", callId: started.actions[0].callId,
    ok: true, result: null });
  assert.equal(idle.state, "idle");
  let output = globalThis.onHaminnEvent({ type: "goal.submit", eventId, intent: submittedIntent });
  assert.equal(output.actions[0].params.key, eventReceiptKey(eventId));
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
  assert.equal(output.actions[0].method, "data.batch");
  assert.ok(output.actions[0].params.operations.some(operation => operation.collection === "agent-runtime" &&
    operation.key === "active-goal"));

  const concurrentlyStarted = { goalId: "g-concurrent-ost", taskId: "t-concurrent-ost", runId: "run-concurrent-ost",
    intent: "并发开始的另一个合成 OST", state: "active", taskType: "one-shot", taskKind: "OST", revision: 1,
    progress: "并发目标正在运行" };
  records.set("agent-runtime:active-goal", { value: concurrentlyStarted, revision: "active-r2" });
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: false,
    error: { code: "E_CONFLICT", message: "active-goal revision changed" } });
  assert.equal(output.actions[0].params.key, eventReceiptKey(eventId));
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
  assert.deepEqual(output.actions[0].params, { collection: "agent-runtime", key: "active-goal" });
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true,
    result: { value: concurrentlyStarted, revision: "active-r2" } });
  assert.equal(output.actions[0].method, "data.batch");
  const queueWrite = output.actions[0].params.operations.find(operation => operation.collection === "inbox");
  assert.equal(queueWrite.value.intent, submittedIntent);
  assert.equal(queueWrite.value.eventId, eventId);
  assert.equal(queueWrite.value.state, "queued");
  assert.equal(output.actions[0].params.operations.some(operation => operation.collection === "agent-runtime" &&
    operation.key === "active-goal"), false, "queue recovery must preserve the concurrent OST record");

  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true,
    result: persistMockBatch(records, output.actions[0].params) });
  assert.equal(output.state, "queued");
  assert.equal(records.get("agent-runtime:active-goal").value.goalId, concurrentlyStarted.goalId);
  assert.equal(records.get(`inbox:${queueWrite.key}`).value.intent, submittedIntent);
  assert.equal(records.get(`inbox:${queueWrite.key}`).value.eventId, eventId);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(eventId)}`).value.queued, true);

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });
});

test("a queued goal CAS conflict recognizes committed receipts and retries when none exists", () => {
  const start = globalThis.onHaminnEvent({ type: "start" });
  const idle = globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId,
    ok: true, result: null });
  assert.equal(idle.state, "idle");
  const current = globalThis.onHaminnEvent({ type: "goal.submit", intent: "当前合成 OST" });
  const provider = globalThis.onHaminnEvent({ type: "tool.result", callId: current.actions[0].callId,
    ok: true, result: mockBatchResult(current.actions[0].params) });
  assert.equal(provider.actions[0].params.key, "provider");

  const eventId = "queued-goal-competing-submit";
  let output = globalThis.onHaminnEvent({ type: "goal.submit", eventId, intent: "只应排队一次的合成 OST" });
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
  assert.equal(output.actions[0].method, "data.batch");
  assert.equal(output.actions[0].params.operations.find(operation => operation.collection === "inbox").value.eventId, eventId);

  const committedReceipt = { eventId, type: "goal.submit", state: "queued", queued: true };
  const key = `event:${eventReceiptKey(eventId).slice("event:".length)}`;
  const records = new Map([[`agent-runtime:${key}`, { value: committedReceipt, revision: "receipt-r1" }]]);
  const conflict = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId,
    ok: false, error: { code: "E_CONFLICT", message: "receipt was committed concurrently" } });
  assert.equal(conflict.actions[0].method, "data.get");
  assert.equal(conflict.actions[0].params.key, eventReceiptKey(eventId));
  const duplicate = globalThis.onHaminnEvent({ type: "tool.result", callId: conflict.actions[0].callId, ok: true,
    result: records.get(`agent-runtime:${eventReceiptKey(eventId)}`) });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.receipt.queued, true);

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });

  const activeCreate = globalThis.onHaminnEvent({ type: "goal.submit", intent: "第二个合成活动 OST" });
  const activeState = activeCreate.actions[0].params.operations.find(operation =>
    operation.collection === "agent-runtime" && operation.key === "active-goal").value;
  const providerRead = globalThis.onHaminnEvent({ type: "tool.result", callId: activeCreate.actions[0].callId,
    ok: true, result: mockBatchResult(activeCreate.actions[0].params) });
  assert.equal(providerRead.actions[0].params.key, "provider");
  const retryEventId = "queued-goal-retry-after-conflict";
  output = globalThis.onHaminnEvent({ type: "goal.submit", eventId: retryEventId, intent: "冲突后仍需排队的合成 OST" });
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: false,
    error: { code: "E_CONFLICT", message: "synthetic queue revision conflict without a receipt" } });
  assert.equal(output.actions[0].params.key, eventReceiptKey(retryEventId));
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
  assert.equal(output.actions[0].params.key, "active-goal");
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true,
    result: { value: activeState, revision: "active-r2" } });
  assert.equal(output.actions[0].method, "data.batch");
  const retriedQueue = output.actions[0].params.operations.find(operation => operation.collection === "inbox");
  assert.equal(retriedQueue.value.eventId, retryEventId);
  const recordsAfterRetry = new Map();
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true,
    result: persistMockBatch(recordsAfterRetry, output.actions[0].params) });
  assert.equal(output.state, "queued");
  assert.equal(recordsAfterRetry.get(`agent-runtime:${eventReceiptKey(retryEventId)}`).value.queued, true);

  const finalReset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: finalReset.actions[0].callId, ok: true, result: null });
});

test("notification and timer intake CAS conflicts preserve event identity and deduplicate by typed receipt", () => {
  const events = [
    { type: "notification.posted", eventId: "notification-intake-cas", subscriptionId: "edt-notification",
      sourcePackage: "com.tencent.mm", occurredAt: 1_800_000_000_000,
      notification: { title: "合成联系人", text: "合成事件正文", category: "msg" } },
    { type: "timer.fired", eventId: "timer-intake-cas", timerId: "edt-timer", scheduledAt: 1_800_000_000_000,
      occurredAt: 1_800_000_000_100, missedCount: 0, scheduleRevision: 3,
      sourceIdentity: { releaseId: "release-test", devRevision: null, trustRevision: 1 } },
  ];
  for (const event of events) {
    const start = globalThis.onHaminnEvent({ type: "start" });
    const idle = globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId, ok: true, result: null });
    assert.equal(idle.state, "idle");
    let output = globalThis.onHaminnEvent(event);
    assert.equal(output.actions[0].params.key, eventReceiptKey(event.eventId));
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true, result: null });
    assert.equal(output.actions[0].method, "data.batch");

    const eventType = event.type === "notification.posted" ? "notification.posted" : "timer.fired";
    const committedReceipt = { eventId: event.eventId, type: eventType, state: "received" };
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: false,
      error: { code: "E_CONFLICT", message: "synthetic competing intake committed the receipt" } });
    assert.equal(output.actions[0].method, "data.get");
    assert.equal(output.actions[0].params.key, eventReceiptKey(event.eventId));
    const duplicate = globalThis.onHaminnEvent({ type: "tool.result", callId: output.actions[0].callId, ok: true,
      result: { value: committedReceipt, revision: "receipt-r1" } });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.type, eventType);

    const retryEvent = { ...event, eventId: `${event.eventId}:retry` };
    const retryStart = globalThis.onHaminnEvent({ type: "start" });
    globalThis.onHaminnEvent({ type: "tool.result", callId: retryStart.actions[0].callId, ok: true, result: null });
    let retry = globalThis.onHaminnEvent(retryEvent);
    retry = globalThis.onHaminnEvent({ type: "tool.result", callId: retry.actions[0].callId, ok: true, result: null });
    retry = globalThis.onHaminnEvent({ type: "tool.result", callId: retry.actions[0].callId, ok: false,
      error: { code: "E_CONFLICT", message: "synthetic conflict without a committed receipt" } });
    assert.equal(retry.actions[0].params.key, eventReceiptKey(retryEvent.eventId));
    retry = globalThis.onHaminnEvent({ type: "tool.result", callId: retry.actions[0].callId, ok: true, result: null });
    assert.equal(retry.actions[0].method, "data.batch");
    const inboxWrite = retry.actions[0].params.operations.find(operation => operation.collection === "inbox");
    assert.equal(inboxWrite.value.eventId, retryEvent.eventId);
    assert.equal(inboxWrite.value.type, event.type);
    globalThis.onHaminnEvent({ type: "tool.result", callId: retry.actions[0].callId, ok: true,
      result: mockBatchResult(retry.actions[0].params) });
  }

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });
});

test("a restored task-done decision resumes HO handoff and loads the next Task revision", () => {
  const now = Date.now();
  const first = { taskId: "task-cas-first", runId: "run-first", objective: "读取最新消息", kind: "screen-work",
    state: "done", dependencies: [], objectKey: null, revision: 2, createdAt: now, planIndex: 0, progress: "已读取" };
  const second = { taskId: "task-cas-second", runId: "run-second", objective: "核对回复结果", kind: "screen-work",
    state: "ready", dependencies: [first.taskId], objectKey: null, revision: 1, createdAt: now, planIndex: 1, progress: "" };
  const active = {
    goalId: "goal-cas-recovery", taskId: first.taskId, runId: first.runId, intent: "读取新消息并核对回复",
    state: "active", taskType: "one-shot", taskKind: "OST", step: 2, revision: 5, createdAt: now,
    goalAttemptStartedAt: now, goalDeadlineAt: now + 1_000_000, progress: "已读取",
    goalPlan: { dependencies: [], objectKey: null }, taskPlan: { dependencies: [], objectKey: null },
    taskRecordKind: "screen-work",
    taskGraph: { coordinatorTaskId: "task-cas-coordinator", coordinatorRunId: "run-coordinator",
      coordinatorRevision: 2, currentTaskId: first.taskId, createdAt: now, tasks: [first, second] },
    lastDecision: { state: "task-done", evidence: "已读取最新消息" }, trace: [],
  };
  const start = globalThis.onHaminnEvent({ type: "start" });
  assert.equal(start.actions[0].params.key, "active-goal");
  const target = globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId, ok: true,
    result: { value: active, revision: "active-r9" } });
  assert.equal(target.actions[0].method, "data.get");
  assert.equal(target.actions[0].params.key, `t:${second.taskId}`);
  const handoff = globalThis.onHaminnEvent({ type: "tool.result", callId: target.actions[0].callId, ok: true,
    result: { value: second, revision: "task-second-r4" } });
  assert.equal(handoff.actions[0].method, "data.batch");
  const operations = handoff.actions[0].params.operations;
  const nextWrite = operations.find(operation => operation.collection === "tasks" && operation.key === `t:${second.taskId}`);
  const activeWrite = operations.find(operation => operation.collection === "agent-runtime" && operation.key === "active-goal");
  assert.equal(nextWrite.expectedRevision, "task-second-r4");
  assert.equal(nextWrite.value.state, "running");
  assert.equal(activeWrite.expectedRevision, "active-r9");
  assert.equal(activeWrite.value.taskId, second.taskId);

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });
});

test("saving a late-result diagnostic preserves the live effect method and parameters", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let activeNetworkCall = null;

  function applyStore(method, params) {
    const operations = method === "data.put" ? [{ op: "put", ...params }] : params.operations;
    for (const operation of operations) {
      const key = `${operation.collection}:${operation.key}`;
      const current = records.get(key);
      if (operation.expectedRevision === "absent" && current) {
        throw Object.assign(new Error("revision conflict"), { code: "E_CONFLICT" });
      }
      if (operation.expectedRevision !== undefined && operation.expectedRevision !== "absent" &&
          current?.revision !== operation.expectedRevision) {
        throw Object.assign(new Error("revision conflict"), { code: "E_CONFLICT" });
      }
    }
    const results = operations.map(operation => {
      const key = `${operation.collection}:${operation.key}`;
      const current = records.get(key);
      if (operation.op === "delete") {
        records.delete(key);
        return { op: "delete", key: operation.key, deleted: !!current };
      }
      const revision = String(Number(current?.revision || 0) + 1);
      records.set(key, { collection: operation.collection, key: operation.key, value: operation.value, revision });
      return { op: "put", key: operation.key, revision };
    });
    return method === "data.put" ? { revision: results[0]?.revision } : { results };
  }

  const start = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId, ok: true, result: null });
  let output = globalThis.onHaminnEvent({ type: "goal.submit", intent: "制造迟到结果关联测试" });
  for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
    const call = output.actions[0];
    if (call.method === "network.request") {
      activeNetworkCall = call;
      break;
    }
    const result = call.method === "data.get" && call.params.key === "provider" ? { value: provider }
      : call.method === "data.get" ? records.get(`${call.params.collection}:${call.params.key}`) || null
        : call.method === "data.scan" ? { items: [] }
          : ["data.put", "data.batch"].includes(call.method) ? applyStore(call.method, call.params)
            : null;
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
  }
  assert.equal(activeNetworkCall?.method, "network.request");

  const stale = globalThis.onHaminnEvent({ type: "tool.result", callId: "old-epoch:w99", ok: true, result: {} });
  assert.equal(stale.actions[0].method, "data.batch");
  const staleSaved = globalThis.onHaminnEvent({ type: "tool.result", callId: stale.actions[0].callId,
    ok: true, result: applyStore("data.batch", stale.actions[0].params) });
  assert.equal(staleSaved.ignored, true);

  const recovered = globalThis.onHaminnEvent({ type: "tool.result", callId: activeNetworkCall.callId,
    ok: false, error: { code: "E_TIMEOUT", retryable: true, message: "synthetic timeout" } });
  assert.equal(recovered.actions?.[0]?.method, "data.batch");

  const reset = globalThis.onHaminnEvent({ type: "start" });
  globalThis.onHaminnEvent({ type: "tool.result", callId: reset.actions[0].callId, ok: true, result: null });
});

function modelCall(params, decide, options = {}) {
  const body = JSON.parse(params.bodyText);
  const text = body.messages?.map(message => typeof message.content === "string" ? message.content : message.content?.map?.(part => part.text || "").join(" ")).join("\n") || "";
  let content;
  if (text.includes("在本 AL 开始任何屏幕动作前")) content = { estimatedMinutes: 15, budgetMinutes: 15, strategy: "先观察再按证据执行" };
  else if (text.includes("判断是否值得保存经验")) content = options.learning || { saveExperience: false, saveTool: false };
  else if (text.includes("本 AL 已到预算检查点")) content = options.review || { choice: "continue", additionalMinutes: 5, reason: "还存在直接可行路径", nextStrategy: "复核现场并继续" };
  else content = decide();
  return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

test("background goal persists progress and completes across screenshot cycles", () => {
  const records = new Map();
  let modelTurn = 0;
  let captures = 0;
  const modelPrompts = [];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  records.set("knowledge:experience:reply-context", { revision: "1", value: {
    type: "experience", state: "active", title: "微信消息上下文回复",
    situation: "收到微信新消息时参考历史上下文", approach: "核对会话并回复", successEvidence: "消息气泡已显示", createdAt: 20,
  } });
  records.set("knowledge:experience:weather", { revision: "1", value: {
    type: "experience", state: "active", title: "天气预报", situation: "查询天气", approach: "打开天气应用", successEvidence: "天气已显示", createdAt: 30,
  } });
  records.set("self-model:bp:reply-style", { revision: "1", value: {
    type: "behavior-pattern", state: "active", scope: "global", title: "简洁友好回复",
    condition: "回复微信朋友消息", guidance: "语气自然、简短、友好", evidence: "用户明确采用过这种回复方式", createdAt: 40,
  } });
  records.set("self-model:bp:weather-style", { revision: "1", value: {
    type: "behavior-pattern", state: "active", scope: "global", title: "天气摘要格式",
    condition: "查询天气预报", guidance: "优先给出本地天气", evidence: "用户明确采用过这种格式", createdAt: 50,
  } });
  records.set("knowledge:tool-candidate:reply-context", { revision: "1", value: {
    type: "tool-candidate", state: "candidate", name: "微信回复流程参考",
    description: "先核对微信会话，再查看上下文并确认拟回复内容", toolRefs: ["interaction.capture", "interaction.tap"], createdAt: 60,
  } });
  records.set("knowledge:tool-candidate:weather", { revision: "1", value: {
    type: "tool-candidate", state: "candidate", name: "天气查询候选",
    description: "打开天气页面并读取天气信息", toolRefs: ["interaction.capture"], createdAt: 70,
  } });
  records.set("knowledge:tool-recipe:reply-context", { revision: "2", value: {
    type: "tool-recipe", state: "active", name: "核对上下文后回复微信消息",
    purpose: "确认当前会话，再根据上下文处理新消息", applicability: "指定联系人对话",
    steps: [
      { toolRef: "interaction.capture", purpose: "核对当前联系人和最新消息" },
      { toolRef: "interaction.inputText", purpose: "仅在确认回复正文后输入" },
      { toolRef: "interaction.capture", purpose: "发送前核对输入框内容和对象" },
    ], createdAt: 65,
  } });
  records.set("knowledge:memory:friend-xiaoming", { revision: "1", value: {
    id: "memory:friend-xiaoming", type: "memory", kind: "fact", state: "active",
    objectRefs: ["contact:小明"], content: "小明喜欢周末徒步", sourceRefs: ["trace:source"], observedAt: 80,
    inference: "observed", tags: ["徒步"], revision: 2,
  } });
  records.set("knowledge:memory:friend-xiaohong", { revision: "1", value: {
    id: "memory:friend-xiaohong", type: "memory", kind: "fact", state: "active",
    objectRefs: ["contact:小红"], content: "新消息需要及时回复", sourceRefs: ["trace:source-2"], observedAt: 90,
    inference: "inferred", tags: ["消息"], revision: 1,
  } });

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "1" });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") {
      if (params.key === "provider") return { value: provider };
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") {
      return { items: [...records.entries()].filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit).map(([key, value]) => ({
          key: key.slice(params.collection.length + 1), ...value,
        })) };
    }
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      modelPrompts.push(body.messages?.map(message => typeof message.content === "string"
        ? message.content : message.content?.map?.(part => part.text || "").join(" ")).join("\n") || "");
      return modelCall(params, () => {
        modelTurn += 1;
        return modelTurn === 1
          ? { state: "wait", confidence: 0.95, evidence: "当前画面没有可处理的新事项", waitMs: 1000 }
          : { state: "done", confidence: 0.98, evidence: "目标已完成，画面显示完成状态" };
      });
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      try {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } });
      }
    }
    return output;
  }

  const submission = { type: "goal.submit", intent: "持续检查小明的新消息并根据上下文处理", eventId: "goal-submit-once" };
  const waiting = deliver(submission);
  assert.equal(waiting.state, "waiting");
  assert.equal(modelTurn, 1);
  assert.equal(captures, 1);
  assert.match(modelPrompts.at(-1), /微信消息上下文回复/);
  assert.doesNotMatch(modelPrompts.at(-1), /天气预报/);
  assert.match(modelPrompts.at(-1), /简洁友好回复/);
  assert.doesNotMatch(modelPrompts.at(-1), /天气摘要格式/);
  assert.match(modelPrompts.at(-1), /微信回复流程参考/);
  assert.doesNotMatch(modelPrompts.at(-1), /天气查询候选/);
  assert.match(modelPrompts.at(-1), /核对上下文后回复微信消息/);
  assert.match(modelPrompts.at(-1), /由你结合本轮截图逐步判断/);
  assert.match(modelPrompts.at(-1), /interaction.inputText/);
  assert.match(modelPrompts.at(-1), /小明喜欢周末徒步/);
  assert.doesNotMatch(modelPrompts.at(-1), /小红/);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(submission.eventId)}`).value.state, "accepted");
  const duplicateSubmission = deliver(submission);
  assert.equal(duplicateSubmission.duplicate, true);
  assert.equal(modelTurn, 1, "a redelivered submission must not start a second OST");
  assert.equal(captures, 1);
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(active.state, "waiting");
  assert.equal(records.get(`goals:g:${active.goalId}`).value.state, "active");
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "waiting");
  const queuedSubmission = { type: "goal.submit", intent: "收集订阅号更新并整理摘要", eventId: "goal-submit-queued" };
  assert.equal(deliver(queuedSubmission).state, "queued");
  assert.equal(deliver(queuedSubmission).duplicate, true);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(queuedSubmission.eventId)}`).value.queued, true);

  const complete = deliver({ type: "tick" });
  assert.equal(complete.state, "done");
  assert.equal(modelTurn, 3);
  assert.equal(captures, 3);
  assert.equal(records.get(`goals:g:${active.goalId}`).value.state, "done");
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "done");
  const secondGoal = [...records.entries()].find(([key, record]) => key.startsWith("goals:g:") && record.value.intent.includes("订阅号"))[1].value;
  assert.equal(secondGoal.state, "done");
  assert.equal([...records.entries()].filter(([key]) => key.startsWith("tasks:t:") && records.get(key).value.state === "done").length, 2);
  const journal = [...records.entries()].filter(([key]) => key.startsWith(`agent-events:e:${active.goalId}:`)).map(([, item]) => item.value);
  assert.equal(journal.length, active.journalSequence,
    "every recorded Worker trace event must be written as an independent record");
  assert.ok(journal.some((event) => event.phase === "model.requested"));
  assert.ok(journal.some((event) => event.phase === "action-loop.started"));
  const taskPlan = journal.find(event => event.phase === "task.classification-requested");
  assert.equal(taskPlan?.contextManifest?.purpose, "task-plan");
  assert.deepEqual(taskPlan?.contextManifest?.selected.sourceRefs, [`task:${active.taskId}:intent`]);
  const learning = journal.find(event => event.phase === "learning.model-requested");
  assert.equal(learning?.contextManifest?.purpose, "learning");
  assert.ok(learning?.contextManifest?.selected.learningTraceRefs.length > 0);
});

test("active Goal and Task plans hydrate on Worker restart and survive later progress writes", () => {
  const now = Date.now();
  const goalId = "goal-plan-preservation";
  const taskId = "task-plan-preservation";
  const records = new Map([
    ["agent-runtime:active-goal", { value: {
      goalId, taskId, runId: "run-plan-preservation", taskType: "one-shot", taskKind: "OST",
      intent: "完成合成任务", state: "running", step: 2, revision: 3, createdAt: now - 1000,
      goalAttemptStartedAt: now - 1000, goalDeadlineAt: now + 10 * 60_000,
      progress: "从已保存进度继续", activeElapsedMs: 0, activeSegmentStartedAt: null,
      actionLoop: { index: 1, status: "running", budgetMinutes: 15, estimatedMinutes: 5, elapsedMs: 0,
        segmentStartedAt: null }, trace: [],
    }, revision: "1" }],
    [`goals:g:${goalId}`, { value: {
      schemaVersion: 1, goalId, intent: "完成合成任务", scope: { packageName: "synthetic.app" },
      triggers: [{ kind: "manual", source: "saved-plan" }], completion: "模型确认合成目标完成",
      priority: 7, state: "active", revision: 3, acceptedBoundary: "after-creation", createdAt: now - 1000,
    }, revision: "3" }],
    [`tasks:t:${taskId}`, { value: {
      schemaVersion: 1, taskId, goalId, runId: "run-plan-preservation", kind: "screen-work",
      objective: "完成合成任务", state: "running", revision: 3,
      dependencies: ["task-prerequisite"], objectKey: "synthetic:object-1",
      progress: "从已保存进度继续", waiting: null, resultRefs: [], createdAt: now - 1000,
    }, revision: "3" }],
  ]);

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider"
      ? { value: { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" } }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "4" });
      return { revision: "4" };
    }
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "4" });
      }
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      return modelCall(params, () => ({ state: "done", evidence: "合成目标已完成并核对当前画面" }), {
        learning: { saveExperience: false, saveTool: false },
      });
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 100; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }

  assert.equal(output.state, "done", JSON.stringify(output));
  const savedGoal = records.get(`goals:g:${goalId}`).value;
  assert.deepEqual(savedGoal.scope, { packageName: "synthetic.app" });
  assert.deepEqual(savedGoal.triggers, [{ kind: "manual", source: "saved-plan" }]);
  assert.equal(savedGoal.completion, "模型确认合成目标完成");
  assert.equal(savedGoal.priority, 7);
  assert.equal(savedGoal.taskKind, "OST");
  const savedTask = records.get(`tasks:t:${taskId}`).value;
  assert.deepEqual(savedTask.dependencies, ["task-prerequisite"]);
  assert.equal(savedTask.objectKey, "synthetic:object-1");
});

test("Worker does not resume an old active Goal when its saved plan cannot be read", () => {
  const active = { goalId: "goal-plan-read-failure", taskId: "task-plan-read-failure",
    intent: "完成合成任务", state: "running", revision: 2, createdAt: Date.now(), trace: [] };
  let output = globalThis.onHaminnEvent({ type: "start" });
  let call = output.actions[0];
  assert.equal(call.method, "data.get");
  output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true,
    result: { value: active, revision: "1" } });
  call = output.actions[0];
  assert.equal(call.params.collection, "goals");
  assert.throws(() => globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
    error: { code: "E_STORAGE", retryable: true, message: "synthetic Goal read outage" } }), error => {
    assert.equal(error.category, "worker-state-persistence");
    assert.equal(error.code, "E_STORAGE");
    assert.match(error.message, /load-active-goal-plan/);
    return true;
  });
});

test("LLM-decomposed Tasks persist, run by dependency order, then return to LLM for whole-OST judgment", () => {
  const records = new Map();
  const actionPrompts = [];
  const scheduledCalls = [];
  let childOneDone = 0;
  let childTwoDone = 0;
  let reviewTurns = 0;
  let captures = 0;
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: provider }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, entry]) => ({ key: key.slice(params.collection.length + 1), ...entry })) };
    if (method === "data.put" || method === "data.batch") {
      const operations = method === "data.put" ? [{ op: "put", ...params }] : params.operations;
      const results = [];
      for (const operation of operations) {
        const key = `${operation.collection}:${operation.key}`;
        const current = records.get(key);
        if (operation.expectedRevision === "absent" && current) throw new Error(`revision conflict: ${key}`);
        if (operation.expectedRevision !== undefined && operation.expectedRevision !== "absent" &&
            current?.revision !== operation.expectedRevision) throw new Error(`revision conflict: ${key}`);
        if (operation.op === "delete") {
          records.delete(key);
          results.push({ op: "delete", key: operation.key, deleted: !!current });
        } else {
          const revision = String(Number(current?.revision || 0) + 1);
          records.set(key, { value: operation.value, revision });
          results.push({ op: "put", key: operation.key, revision });
        }
      }
      return method === "data.put" ? { revision: results[0]?.revision } : { results };
    }
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "interaction.tap") return { accepted: true };
    if (method === "worker.wait") return { waitedMs: params.ms };
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      const prompt = body.messages.map(message => typeof message.content === "string"
        ? message.content : message.content?.map?.(part => part.text || "").join(" ")).join("\n");
      let value;
      if (prompt.includes("用户语义指令：")) {
        value = { taskType: "one-shot", estimatedMinutes: 5, budgetMinutes: 15, strategy: "先读取，再回复并核验",
          subtasks: [
            { objective: "读取合成会话的最新消息", dependencies: [] },
            { objective: "拟定并核验合成回复", dependencies: [0], objectKey: "synthetic:chat:one" },
          ] };
      } else if (prompt.includes("判断是否值得保存经验")) {
        value = { saveExperience: false, saveTool: false };
      } else if (prompt.includes("在本 AL 开始任何屏幕动作前")) {
        value = { estimatedMinutes: 5, budgetMinutes: 15, strategy: "完成当前调度单元" };
      } else if (prompt.includes("截图尺寸")) {
        actionPrompts.push(prompt);
        if (prompt.includes("子任务计划已逐项处理")) {
          reviewTurns += 1;
          if (reviewTurns === 1) {
            value = { state: "action", evidence: "所有子任务完成，但需要在当前界面进行最终整体核对",
              action: { type: "tap", target: "synthetic overall review control", label: "Review", x: 0.5, y: 0.5 } };
          } else value = { state: "done", evidence: "我已核对整体用户目标，所有要求均已完成", operationResult: "verified" };
        } else if (prompt.includes("子任务 1/2")) {
          childOneDone += 1;
          value = { state: "task-done", evidence: "已读取并确认合成会话中的最新消息" };
        } else if (prompt.includes("子任务 2/2")) {
          childTwoDone += 1;
          value = { state: "task-done", evidence: "已拟定回复并完成当前子任务核对" };
        } else throw new Error(`Unexpected action context: ${prompt.slice(0, 500)}`);
      } else throw new Error(`Unexpected model purpose: ${prompt.slice(0, 160)}`);
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }) };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 160; turn += 1) {
      const call = output.actions[0];
      scheduledCalls.push(call.method);
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  const output = deliver({ type: "goal.submit", intent: "阅读合成会话的新消息，结合上下文拟定回复并确认整体目标完成" });

  assert.equal(output.state, "done", JSON.stringify({ output, childOneDone, childTwoDone, reviewTurns, captures }));
  assert.equal(childOneDone, 1);
  assert.equal(childTwoDone, 1);
  assert.equal(reviewTurns, 2, JSON.stringify({ message: "whole-OST judgment remains with the LLM after all children are done",
    prompts: actionPrompts.map(prompt => prompt.match(/Goal 子任务计划[^\n]*/)?.[0] || prompt.match(/当前 HO 调度的子任务[^\n]*/)?.[0]) }));
  assert.ok(captures >= 4, "each child and the final coordinator review must observe the synthetic screen");
  const goal = [...records.entries()].find(([key]) => key.startsWith("goals:g:"))[1].value;
  const savedActive = records.get("agent-runtime:active-goal").value;
  const tasks = [...records.entries()].filter(([key]) => key.startsWith("tasks:t:")).map(([, entry]) => entry.value);
  const coordinator = tasks.find(task => task.kind === "coordination");
  const children = tasks.filter(task => task.kind === "screen-work").sort((a, b) => a.planIndex - b.planIndex);
  assert.equal(goal.state, "done");
  assert.equal(coordinator.state, "done");
  assert.equal(savedActive.taskGraph.coordinatorRevision, coordinator.revision);
  assert.deepEqual(children.map(task => task.state), ["done", "done"]);
  assert.deepEqual(children[1].dependencies, [children[0].taskId]);
  assert.equal(children.find(task => task.objective.includes("拟定"))?.objectKey, "synthetic:chat:one");
  assert.ok(actionPrompts.some(prompt => prompt.includes("当前 OST：阅读合成会话的新消息")));
  assert.ok(actionPrompts.some(prompt => prompt.includes("子任务计划已逐项处理")));
  assert.ok(scheduledCalls.filter(method => method === "interaction.tap").length === 1);
});

test("LLM requests Persona and object Memory only when relevant and HO restores context after restart", () => {
  const records = new Map();
  const goalId = "goal-object-memory-context";
  const active = { goalId, taskId: "task-object-memory-context", runId: "run-object-memory-context",
    intent: "给朋友回复消息", state: "running", step: 3, revision: 4, createdAt: Date.now(),
    goalAttemptStartedAt: Date.now(), goalDeadlineAt: Date.now() + 20 * 60_000, progress: "准备查看当前会话",
    actionLoop: { index: 1, status: "running", budgetMinutes: 15, estimatedMinutes: 5, elapsedMs: 30_000, segmentStartedAt: null }, trace: [] };
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  records.set("knowledge:memory:contact-zhangsan", { value: {
    id: "memory:contact-zhangsan", type: "memory", kind: "fact", state: "active",
    objectRefs: ["contact:张三"], content: "张三喜欢周末徒步", sourceRefs: ["trace:synthetic"], observedAt: 10,
    inference: "observed", tags: ["徒步"], revision: 1,
  }, revision: "1" });
  records.set("knowledge:experience:reply", { value: {
    type: "experience", state: "active", title: "结合上下文回复朋友", situation: "微信朋友消息回复",
    approach: "先观察并核对对象", successEvidence: "目标消息已发送", createdAt: 20,
  }, revision: "3" });
  records.set("knowledge:tool-candidate:reply-flow", { value: {
    type: "tool-candidate", state: "candidate", name: "查看会话再回复",
    description: "核对会话和最新上下文后回复朋友", toolRefs: ["interaction.capture", "interaction.input"], createdAt: 20,
  }, revision: "4" });
  records.set("knowledge:tool-recipe:reply-flow", { value: {
    type: "tool-recipe", state: "active", name: "回复朋友消息前核对会话",
    purpose: "结合聊天上下文回复朋友消息", applicability: "明确指定联系人",
    steps: [
      { toolRef: "interaction.capture", purpose: "确认联系人会话和消息" },
      { toolRef: "interaction.inputText", purpose: "输入已经核对的回复" },
      { toolRef: "interaction.capture", purpose: "检查发送后的消息状态" },
    ], createdAt: 25,
  }, revision: "6" });
  records.set("self-model:bp:reply", { value: {
    type: "behavior-pattern", state: "active", scope: "global", title: "自然简洁回复",
    condition: "回复朋友消息", guidance: "自然直接，不复述对方整句", evidence: "已用于成功回复", createdAt: 20,
  }, revision: "5" });
  records.set("self-model:identity-core", { value: {
    schemaVersion: 1, type: "identity-core", content: "我表达自然直接，也会先理解对方的处境。", version: 2,
  }, revision: "1" });
  const actionPrompts = [];
  let actionTurns = 0;
  let captures = 0;
  let memoryScans = 0;
  let restartedDuringLookup = false;

  function tool(method, params) {
    if (method === "data.get") {
      if (params.collection === "screen-interaction" && params.key === "provider") return { value: provider };
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") {
      if (params.prefix === "memory:") memoryScans += 1;
      return { items: [...records.entries()].filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
        .slice(0, params.limit).map(([key, value]) => ({ key: key.slice(params.collection.length + 1), ...value })) };
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" });
      return { revision: "2" };
    }
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "2" });
      }
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      const prompt = body.messages.map(message => typeof message.content === "string"
        ? message.content : message.content?.map?.(part => part.text || "").join(" ")).join("\n");
      if (prompt.includes("截图尺寸")) actionPrompts.push(prompt);
      return modelCall(params, () => {
        actionTurns += 1;
        if (actionTurns === 1) return { state: "context", evidence: "本次回复需要遵循用户设定的表达偏好", contextRequest: { includeIdentityCore: true } };
        if (actionTurns === 2) return { state: "context", evidence: "当前截图显示张三会话，回复需要了解相关历史背景", contextRequest: { memoryObjectRefs: ["contact:张三"] } };
        if (actionTurns === 3) return { state: "context", evidence: "再次确认张三关系背景和角色偏好", contextRequest: {
          memoryObjectRefs: ["contact:张三"], includeIdentityCore: true,
        } };
        return { state: "done", evidence: "已结合张三记忆和角色偏好完成回复并核对结果" };
      });
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 100; turn += 1) {
    const call = output.actions[0];
    if (!restartedDuringLookup && call.method === "data.scan" && call.params.prefix === "memory:" &&
        records.get("agent-runtime:active-goal")?.value.pendingContextRequest?.objectRefs?.length) {
      restartedDuringLookup = true;
      output = globalThis.onHaminnEvent({ type: "start" });
      continue;
    }
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }

  assert.equal(output.state, "done", JSON.stringify({ output, actionTurns, captures, memoryScans,
    pendingContextRequest: records.get("agent-runtime:active-goal")?.value?.pendingContextRequest,
    state: records.get("agent-runtime:active-goal")?.value?.state,
    trace: records.get("agent-runtime:active-goal")?.value?.trace?.slice(-8) }));
  assert.equal(restartedDuringLookup, true);
  assert.equal(actionTurns, 4);
  assert.equal(captures, 4, "the model should inspect a fresh screenshot after each context request");
  assert.equal(memoryScans, 2, "a duplicate context request must not repeat the memory scan");
  assert.doesNotMatch(actionPrompts[0], /张三喜欢周末徒步/);
  assert.doesNotMatch(actionPrompts[0], /我表达自然直接/);
  assert.match(actionPrompts[0], /state=context/);
  assert.match(actionPrompts[0], /includeIdentityCore/);
  assert.doesNotMatch(actionPrompts[1], /张三喜欢周末徒步/);
  assert.match(actionPrompts[1], /我表达自然直接，也会先理解对方的处境/);
  assert.match(actionPrompts[1], /Identity Core（版本 2/);
  assert.match(actionPrompts[2], /张三喜欢周末徒步/);
  assert.match(actionPrompts[2], /Worker 恢复时重新载入用户 Identity Core 第 2 版/);
  assert.match(actionPrompts[2], /contact:张三/);
  assert.match(actionPrompts[3], /本次 OST 已达到/);
  const saved = records.get("agent-runtime:active-goal").value;
  const actionRequests = saved.trace.filter(event => event.phase === "model.requested" && event.purpose === "action");
  const manifest = actionRequests[2]?.contextManifest;
  assert.equal(manifest?.purpose, "action");
  assert.deepEqual(manifest?.selected.identityCore, { source: "user", version: 2 });
  assert.deepEqual(manifest?.selected.memories, [{ ref: "knowledge:memory:contact-zhangsan", revision: "1", recordRevision: "1" }]);
  assert.deepEqual(manifest?.selected.experiences, [{ ref: "knowledge:experience:reply", revision: "1", recordRevision: "3" }]);
  assert.deepEqual(manifest?.selected.behaviorPatterns, [{ ref: "self-model:bp:reply", recordRevision: "5" }]);
  assert.deepEqual(manifest?.selected.toolCandidates, [{ ref: "knowledge:tool-candidate:reply-flow", recordRevision: "4" }]);
  assert.deepEqual(manifest?.selected.toolRecipes, [{ ref: "knowledge:tool-recipe:reply-flow", recordRevision: "6" }]);
  assert.equal(saved.trace.some(event => event.phase === "context.requested" && event.includeIdentityCore), true);
  assert.equal(saved.trace.some(event => event.phase === "memory.context-loaded" && event.memoryCount === 1), true);
  assert.equal(saved.trace.some(event => event.phase === "identity-core.context-loaded" && event.version === 2), true);
  assert.equal(saved.trace.some(event => event.phase === "identity-core.context-restored" && event.version === 2), true);
  assert.equal(saved.trace.some(event => event.phase === "context.query-limited"), true);
});

test("an EDT notification is deduplicated, matched by the LLM, and creates one separate OST after durable acknowledgement", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const eventId = "notification:synthetic-001";
  let matchCalls = 0;
  let captures = 0;
  const hostDeadlines = [];

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: String(Number(records.get(key)?.revision || 0) + 1) });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") {
      if (params.collection === "screen-interaction" && params.key === "provider") return { value: provider };
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") {
      return { items: [...records.entries()].filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
        .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit).map(([key, value]) => ({
          key: key.slice(params.collection.length + 1), ...value,
        })) };
    }
    if (method === "notifications.subscribe") return { ready: true, state: "subscribed", subscriptionId: params.subscriptionId };
    if (method === "notifications.unsubscribe") return { ready: true, state: "unsubscribed", subscriptionId: params.subscriptionId, removed: 1 };
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "network.request") {
      hostDeadlines.push(params.__haminnWorkerDeadlineAt);
      const body = JSON.parse(params.bodyText);
      const prompt = body.messages?.map(message => typeof message.content === "string" ? message.content
        : message.content?.map?.(part => part.text || "").join(" ")).join("\n") || "";
      let content;
      if (prompt.includes("用户语义指令")) content = { taskType: "event-driven", trigger: {
        kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到新微信消息时触发",
      } };
      else if (prompt.includes("指定 EDT 的触发条件")) {
        matchCalls += 1;
        content = { decision: "trigger", reason: "来源和内容满足用户设定", ostIntent: "阅读本条新消息并依据历史上下文回复" };
      } else if (prompt.includes("在本 AL 开始任何屏幕动作前")) {
        content = { estimatedMinutes: 3, budgetMinutes: 15, strategy: "从当前聊天页面观察并完成本条回复" };
      } else if (prompt.includes("判断是否值得保存经验")) content = { saveExperience: false, saveTool: false };
      else content = { state: "done", evidence: "本条测试 OST 已按模型判断完成" };
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  const submitted = deliver({ type: "goal.submit", intent: "微信收到新消息时自动根据上下文回复", eventId: "edt-submit-1" });
  assert.equal(submitted.state, "event-driven");
  const eventTask = [...records.entries()].find(([key]) => key.startsWith("event-tasks:ed:"))[1].value;
  assert.equal(eventTask.state, "active");
  assert.deepEqual(eventTask.trigger.sourcePackages, ["com.tencent.mm"]);

  const notification = { type: "notification.posted", eventId, subscriptionId: eventTask.eventTaskId,
    sourcePackage: "com.tencent.mm", occurredAt: 1_800_000_000_000,
    notification: { title: "zhyuzh", text: "一条合成测试消息", category: "msg" } };
  const started = deliver(notification);
  assert.equal(started.state, "event-start-pending", JSON.stringify({ started, active: records.get("agent-runtime:active-goal")?.value }));
  assert.equal(matchCalls, 1);
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(active.taskType, "one-shot");
  assert.equal(active.parentEventTaskId, eventTask.eventTaskId);
  assert.equal(active.sourceEventId, eventId);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(eventId)}`).value.state, "triggered");
  assert.equal(records.has(`inbox:${notificationInboxKey(eventId)}`), false);
  const matchRequest = [...records.entries()].filter(([key]) => key.startsWith(`agent-events:e:${eventTask.goalId}:`))
    .map(([, item]) => item.value).find(entry => entry.phase === "event.match-requested");
  assert.equal(matchRequest?.contextManifest?.purpose, "event-match");
  assert.deepEqual(matchRequest?.contextManifest?.selected.sourceRefs,
    [`event-task:${eventTask.eventTaskId}`, `notification:${eventId}`]);

  assert.equal(deliver(notification).duplicate, true);
  assert.equal(matchCalls, 1, "redelivery must not build another OST");
  const completed = deliver({ type: "event.acknowledged", eventId });
  assert.equal(completed.state, "done");
  assert.ok(captures >= 1);
  assert.equal(hostDeadlines[0], undefined, "EDT classification is not bounded as a one-shot task");
  assert.equal(hostDeadlines[1], undefined, "matching an event does not start the OST clock");
  assert.ok(Number.isFinite(hostDeadlines[2]), "the triggered OST carries its own host deadline");
  assert.equal(records.get("agent-runtime:active-goal").value.sourceEventId, eventId);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active");
});

test("a recurring timer EDT persists each trigger as a separate OST and remains active", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const hostDeadlines = [];
  const schedule = { kind: "interval", intervalMs: 60_000, firstAt: Date.now() + 60_000 };
  let captures = 0;
  let timerSchedules = 0;
  let actionModelCalls = 0;
  const modelPrompts = [];

  function tool(method, params) {
    if (method === "data.batch") {
      for (const operation of params.operations) {
        const key = `${operation.collection}:${operation.key}`;
        if (operation.op === "delete") records.delete(key);
        else records.set(key, { value: operation.value,
          revision: String(Number(records.get(key)?.revision || 0) + 1) });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") {
      if (params.collection === "screen-interaction" && params.key === "provider") return { value: provider };
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, item]) => ({ key: key.slice(params.collection.length + 1), ...item })) };
    if (method === "timers.schedule") {
      timerSchedules += 1;
      return { ready: true, state: "scheduled", timerId: params.timerId, schedule: params.schedule,
        nextDueAt: params.schedule.firstAt, scheduleRevision: 1, precision: "system-managed" };
    }
    if (method === "timers.cancel") return { ready: true, state: "cancelled", timerId: params.timerId };
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "network.request") {
      hostDeadlines.push(params.__haminnWorkerDeadlineAt);
      const body = JSON.parse(params.bodyText);
      const prompt = body.messages?.map(message => typeof message.content === "string" ? message.content
        : message.content?.map?.(part => part.text || "").join(" ")).join("\n") || "";
      modelPrompts.push(prompt);
      let content;
      if (prompt.includes("用户语义指令")) content = { taskType: "event-driven", trigger: {
        kind: "timer", description: "每分钟执行一次测试任务", schedule,
      } };
      else if (prompt.includes("在本 AL 开始任何屏幕动作前")) {
        content = { estimatedMinutes: 2, budgetMinutes: 15, strategy: "观察当前页面后完成本次工作" };
      } else if (prompt.includes("判断是否值得保存经验")) content = { saveExperience: false, savePattern: false, saveTool: false };
      else {
        actionModelCalls += 1;
        content = actionModelCalls === 1
          ? { state: "wait", evidence: "等待短暂变化后继续当前 OST", waitMs: 10_000 }
          : { state: "done", evidence: "本次计时触发的 OST 已完成" };
      }
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true,
        result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  assert.equal(deliver({ type: "goal.submit", intent: "每分钟检查当前页面并完成符合条件的工作",
    eventId: "timer-edt-submit" }).state, "event-driven");
  const eventTask = [...records.entries()].find(([key]) => key.startsWith("event-tasks:ed:"))[1].value;
  assert.equal(eventTask.state, "active");
  assert.deepEqual(eventTask.trigger.schedule, schedule);
  assert.equal(timerSchedules, 1);

  const scheduledAt = schedule.firstAt;
  const eventId = `worker-timer:${eventTask.eventTaskId}:1:${scheduledAt}`;
  const timerEvent = { type: "timer.fired", eventId, timerId: eventTask.eventTaskId,
    scheduledAt, occurredAt: scheduledAt + 45_000, missedCount: 3, scheduleRevision: 1,
    sourceIdentity: { releaseId: "release-test", devRevision: null, trustRevision: 2 } };
  const started = deliver(timerEvent);
  assert.equal(started.state, "event-start-pending");
  const firstOst = records.get("agent-runtime:active-goal").value;
  assert.equal(firstOst.taskType, "one-shot");
  assert.equal(firstOst.parentEventTaskId, eventTask.eventTaskId);
  assert.equal(firstOst.triggerContext.missedCount, 3);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(eventId)}`).value.state, "triggered");
  assert.equal(records.has(`inbox:${timerInboxKey(eventId)}`), false);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active");
  assert.doesNotMatch(modelPrompts.join("\n"), /指定 EDT 的触发条件/,
    "a timer is a deterministic trigger and does not need notification semantic matching");
  assert.equal(deliver(timerEvent).duplicate, true);
  assert.equal(timerSchedules, 1);

  assert.equal(deliver({ type: "event.acknowledged", eventId }).state, "waiting");
  const waitingOst = records.get("agent-runtime:active-goal").value;
  assert.equal(waitingOst.sourceEventId, eventId);
  assert.equal(waitingOst.waiting.automatic, true);

  const scheduledAt2 = scheduledAt + schedule.intervalMs;
  const eventId2 = `worker-timer:${eventTask.eventTaskId}:1:${scheduledAt2}`;
  const timerEvent2 = { ...timerEvent, eventId: eventId2, scheduledAt: scheduledAt2,
    occurredAt: scheduledAt2 + 2_000, missedCount: 0 };
  assert.equal(deliver(timerEvent2).state, "waiting");
  assert.equal(records.get("agent-runtime:active-goal").value.sourceEventId, eventId,
    "a new trigger must not replace the OST that is already waiting");
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active");
  assert.ok(records.has(`inbox:${timerInboxKey(eventId2)}`), "the next timer trigger remains durably queued");

  const resumed = deliver({ type: "tick" });
  assert.equal(resumed.state, "event-start-pending");
  const secondOst = records.get("agent-runtime:active-goal").value;
  assert.equal(secondOst.sourceEventId, eventId2);
  assert.notEqual(secondOst.goalId, firstOst.goalId);
  assert.equal(records.get(`goals:g:${firstOst.goalId}`).value.state, "done");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(eventId2)}`).value.state, "triggered");
  assert.equal(records.has(`inbox:${timerInboxKey(eventId2)}`), false);
  assert.equal(deliver({ type: "event.acknowledged", eventId: eventId2 }).state, "done");
  assert.ok(captures >= 1);
  assert.ok(Number.isFinite(hostDeadlines.find(Number.isFinite)), "the triggered OST receives its own deadline");
  assert.equal(records.get("agent-runtime:active-goal").value.sourceEventId, eventId2);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active",
    "completing one timer-triggered OST leaves the recurring EDT enabled");
});

test("timer EDT pause, resume and cancel fence off events from an older schedule revision", () => {
  const records = new Map();
  const eventTask = {
    schemaVersion: 1, eventTaskId: "edt-timer-control", goalId: "g-edt-timer-control",
    taskId: "t-edt-timer-control", runId: "run-edt-timer-control", intent: "每分钟检查并整理页面",
    trigger: { kind: "timer", description: "每分钟", schedule: { kind: "interval", intervalMs: 60_000, firstAt: 180_000_000_000 } },
    state: "active", revision: 2, createdAt: 10, updatedAt: 10, missedNotifications: 0,
    journalSequence: 0, registration: { state: "scheduled", scheduleRevision: 1 },
  };
  const active = { goalId: eventTask.goalId, taskId: eventTask.taskId, runId: eventTask.runId,
    intent: eventTask.intent, state: "event-driven", taskType: "event-driven", taskKind: "EDT",
    eventTaskId: eventTask.eventTaskId, progress: "事件任务已启用", createdAt: 10, revision: 2 };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  records.set(`event-tasks:ed:${eventTask.eventTaskId}`, { value: eventTask, revision: "1" });
  const sideEffects = [];
  let nextScheduleRevision = 1;

  function tool(method, params) {
    if (method === "data.batch") {
      for (const operation of params.operations) {
        const key = `${operation.collection}:${operation.key}`;
        if (operation.op === "delete") records.delete(key);
        else records.set(key, { value: operation.value,
          revision: String(Number(records.get(key)?.revision || 0) + 1) });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, item]) => ({ key: key.slice(params.collection.length + 1), ...item })) };
    if (method === "timers.cancel") {
      sideEffects.push(method);
      return { ready: true, state: "cancelled", timerId: params.timerId };
    }
    if (method === "timers.schedule") {
      sideEffects.push(method);
      nextScheduleRevision += 1;
      return { ready: true, state: "scheduled", timerId: params.timerId, schedule: params.schedule,
        nextDueAt: params.schedule.firstAt, scheduleRevision: nextScheduleRevision, precision: "system-managed" };
    }
    if (method === "interaction.capture" || method === "network.request") {
      throw new Error("paused or stale timer must not start screen work");
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true,
        result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "event-driven");
  const pauseId = "timer-control-pause";
  assert.equal(deliver({ type: "event-task.control", eventId: pauseId,
    eventTaskId: eventTask.eventTaskId, command: "pause" }).controlApplied, true);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "paused");
  assert.deepEqual(sideEffects, ["timers.cancel"]);

  const resumeId = "timer-control-resume";
  assert.equal(deliver({ type: "event-task.control", eventId: resumeId,
    eventTaskId: eventTask.eventTaskId, command: "resume" }).controlApplied, true);
  const resumed = records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value;
  assert.equal(resumed.state, "active");
  assert.equal(resumed.registration.scheduleRevision, 2);

  const scheduledAt = eventTask.trigger.schedule.firstAt;
  const staleEventId = `worker-timer:${eventTask.eventTaskId}:1:${scheduledAt}`;
  const stale = { type: "timer.fired", eventId: staleEventId, timerId: eventTask.eventTaskId,
    scheduledAt, occurredAt: scheduledAt + 1000, missedCount: 0, scheduleRevision: 1 };
  assert.equal(deliver(stale).state, "event-driven");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(staleEventId)}`).value.state, "ignored");
  assert.equal(records.has(`inbox:${timerInboxKey(staleEventId)}`), false);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active");
  assert.equal(deliver(stale).duplicate, true);

  const cancelId = "timer-control-cancel";
  assert.equal(deliver({ type: "event-task.control", eventId: cancelId,
    eventTaskId: eventTask.eventTaskId, command: "cancel" }).controlApplied, true);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "cancelled");
  assert.deepEqual(sideEffects, ["timers.cancel", "timers.schedule", "timers.cancel"]);
});

test("EDT controls persist before subscription effects, recover auth, and deduplicate completed commands", () => {
  const records = new Map();
  const eventTask = {
    schemaVersion: 1, eventTaskId: "edt-control-1", goalId: "g-edt-control", taskId: "t-edt-control",
    runId: "run-edt-control", intent: "符合条件时处理新消息", trigger: {
      kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到新消息",
    }, state: "active", revision: 2, createdAt: 10, updatedAt: 10, missedNotifications: 0, journalSequence: 0,
  };
  const active = { goalId: eventTask.goalId, taskId: eventTask.taskId, runId: eventTask.runId,
    intent: eventTask.intent, state: "event-driven", taskType: "event-driven", taskKind: "EDT",
    eventTaskId: eventTask.eventTaskId, progress: "事件任务已启用", createdAt: 10, revision: 2 };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  records.set(`event-tasks:ed:${eventTask.eventTaskId}`, { value: eventTask, revision: "1" });
  let subscribeResult = { ready: true, state: "subscribed", listenerAccess: true };
  const sideEffects = [];

  function tool(method, params) {
    if (method === "data.batch") {
      for (const operation of params.operations) {
        const key = `${operation.collection}:${operation.key}`;
        if (operation.op === "delete") records.delete(key);
        else records.set(key, { value: operation.value, revision: String(Number(records.get(key)?.revision || 0) + 1) });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, item]) => ({ key: key.slice(params.collection.length + 1), ...item })) };
    if (method === "notifications.unsubscribe") {
      sideEffects.push(method);
      return { ready: true, state: "unsubscribed", subscriptionId: params.subscriptionId, removed: 1 };
    }
    if (method === "notifications.subscribe") {
      sideEffects.push(method);
      return { ...subscribeResult, subscriptionId: params.subscriptionId };
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "event-driven");
  const pauseEvent = { type: "event-task.control", eventId: "edt-control-pause-1",
    eventTaskId: eventTask.eventTaskId, command: "pause" };
  const paused = deliver(pauseEvent);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "paused");
  assert.equal(records.get("goals:g:g-edt-control").value.state, "paused");
  assert.equal(records.get("tasks:t:t-edt-control").value.state, "paused");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(pauseEvent.eventId)}`).value.state, "completed");
  assert.ok(paused.state === "event-driven" || paused.state === "waiting");
  assert.equal(sideEffects.filter(method => method === "notifications.unsubscribe").length, 1);
  assert.equal(deliver(pauseEvent).duplicate, true);
  assert.equal(sideEffects.filter(method => method === "notifications.unsubscribe").length, 1,
    "a durable completed control must not repeat its native side effect");

  subscribeResult = { ready: false, state: "needs-system-access", listenerAccess: false };
  const firstResume = { type: "event-task.control", eventId: "edt-control-resume-1",
    eventTaskId: eventTask.eventTaskId, command: "resume" };
  deliver(firstResume);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "needs-system-access");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(firstResume.eventId)}`).value.outcome, "authorization-required");

  subscribeResult = { ready: true, state: "subscribed", listenerAccess: true };
  const authorizedResume = { type: "event-task.control", eventId: "edt-control-resume-2",
    eventTaskId: eventTask.eventTaskId, command: "resume" };
  deliver(authorizedResume);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "active");
  assert.equal(records.get("goals:g:g-edt-control").value.state, "active");
  assert.equal(records.get("tasks:t:t-edt-control").value.state, "waiting");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(authorizedResume.eventId)}`).value.resultState, "active");
  assert.equal(sideEffects.filter(method => method === "notifications.subscribe").length, 2);
});

test("an EDT control CAS recovery reloads active-goal and cannot overwrite a concurrently started OST", () => {
  const records = new Map();
  const eventTask = {
    schemaVersion: 1, eventTaskId: "edt-control-cas", goalId: "g-edt-control-cas", taskId: "t-edt-control-cas",
    runId: "run-edt-control-cas", intent: "符合条件时处理新消息", trigger: {
      kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到新消息",
    }, state: "active", revision: 2, createdAt: 10, updatedAt: 10, missedNotifications: 0, journalSequence: 0,
  };
  const active = { goalId: eventTask.goalId, taskId: eventTask.taskId, runId: eventTask.runId,
    intent: eventTask.intent, state: "event-driven", taskType: "event-driven", taskKind: "EDT",
    eventTaskId: eventTask.eventTaskId, progress: "事件任务已启用", createdAt: 10, revision: 2 };
  records.set("agent-runtime:active-goal", { value: active, revision: "active-r1" });
  records.set(`event-tasks:ed:${eventTask.eventTaskId}`, { value: eventTask, revision: "edt-r1" });
  let conflictOnce = true;
  let sideEffectCount = 0;
  let retryOperations = null;

  function tool(method, params) {
    if (method === "data.batch") {
      const hasControlFinalWrite = params.operations.some(operation => operation.collection === "goals") &&
        params.operations.some(operation => operation.collection === "event-tasks") &&
        params.operations.some(operation => operation.collection === "agent-runtime" && operation.key === "active-goal");
      if (hasControlFinalWrite && conflictOnce) {
        conflictOnce = false;
        const concurrentlyStartedOst = { goalId: "g-new-ost", taskId: "t-new-ost", runId: "run-new-ost",
          intent: "新通知触发的单次目标", state: "active", taskType: "one-shot", taskKind: "OST", revision: 1 };
        records.set("agent-runtime:active-goal", { value: concurrentlyStartedOst, revision: "active-r2" });
        return { __toolError: { code: "E_CONFLICT", message: "active-goal revision changed" } };
      }
      if (params.operations.some(operation => operation.collection === "event-tasks") &&
          params.operations.some(operation => operation.collection === "goals")) retryOperations = params.operations;
      return persistMockBatch(records, params);
    }
    if (method === "data.put") {
      const revision = `put-r${Number(records.get(`${params.collection}:${params.key}`)?.revision?.slice(5) || 0) + 1}`;
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision });
      return { revision };
    }
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "notifications.unsubscribe") {
      sideEffectCount += 1;
      return { ready: true, state: "unsubscribed", subscriptionId: params.subscriptionId, removed: 1 };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      const result = tool(call.method, call.params);
      output = result?.__toolError
        ? globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: result.__toolError })
        : globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "event-driven");
  const command = { type: "event-task.control", eventId: "edt-control-cas-pause",
    eventTaskId: eventTask.eventTaskId, command: "pause" };
  const result = deliver(command);
  assert.equal(result.controlApplied, true);
  assert.equal(sideEffectCount, 1, "a persisted prepared control must not replay its native effect during final-save recovery");
  assert.equal(records.get("agent-runtime:active-goal").value.goalId, "g-new-ost");
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "paused");
  assert.ok(retryOperations);
  assert.equal(retryOperations.some(operation => operation.collection === "agent-runtime" && operation.key === "active-goal"),
    false, "the refreshed active OST must be excluded from the EDT control write set");
});

test("an EDT registration CAS recovery preserves a newer active OST while saving the subscription receipt", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let subscriptionReturned = false;
  let conflictOnce = true;
  let retryOperations = null;
  let activeGoalReads = 0;

  function tool(method, params) {
    if (method === "data.batch") {
      const statusWrite = subscriptionReturned && params.operations.some(operation => operation.collection === "event-tasks") &&
        params.operations.some(operation => operation.collection === "agent-runtime" && operation.key === "active-goal");
      if (statusWrite && conflictOnce) {
        conflictOnce = false;
        const concurrentlyStartedOst = { goalId: "g-subscription-ost", taskId: "t-subscription-ost", runId: "run-subscription-ost",
          intent: "新通知触发的单次目标", state: "active", taskType: "one-shot", taskKind: "OST", revision: 1 };
        records.set("agent-runtime:active-goal", { value: concurrentlyStartedOst, revision: "active-r2" });
        return { __toolError: { code: "E_CONFLICT", message: "active-goal revision changed" } };
      }
      if (subscriptionReturned && params.operations.some(operation => operation.collection === "event-tasks")) retryOperations = params.operations;
      return persistMockBatch(records, params);
    }
    if (method === "data.put") {
      const revision = `put-r${Number(records.get(`${params.collection}:${params.key}`)?.revision?.slice(5) || 0) + 1}`;
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision });
      return { revision };
    }
    if (method === "data.get") {
      if (params.collection === "screen-interaction" && params.key === "provider") return { value: provider };
      if (params.collection === "agent-runtime" && params.key === "active-goal") activeGoalReads += 1;
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") return { items: [] };
    if (method === "notifications.subscribe") {
      subscriptionReturned = true;
      return { ready: true, state: "subscribed", subscriptionId: params.subscriptionId, listenerAccess: true };
    }
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      const prompt = body.messages?.map(message => typeof message.content === "string" ? message.content
        : message.content?.map?.(part => part.text || "").join(" ")).join("\n") || "";
      const content = prompt.includes("用户语义指令") ? { taskType: "event-driven", trigger: {
        kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到微信消息",
      } } : { estimatedMinutes: 2, budgetMinutes: 15, strategy: "登记通知并按每次触发启动 OST" };
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      const result = tool(call.method, call.params);
      output = result?.__toolError
        ? globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: result.__toolError })
        : globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  const result = deliver({ type: "goal.submit", eventId: "edt-subscription-cas-submit",
    intent: "微信收到新消息时根据上下文回复" });
  assert.equal(result.state, "event-driven");
  const eventTask = [...records.entries()].find(([key]) => key.startsWith("event-tasks:ed:"))[1].value;
  assert.equal(eventTask.state, "active");
  assert.ok([...records.entries()].some(([key, value]) => key.startsWith(`agent-events:e:${eventTask.goalId}:`) &&
    value.value.phase === "event-task.registration-completed"), "the EDT outcome must remain auditable after recovery");
  assert.notEqual(eventTask.goalId, "g-subscription-ost");
  assert.equal(records.get("agent-runtime:active-goal").value.goalId, "g-subscription-ost");
  assert.ok(retryOperations);
  assert.ok(activeGoalReads >= 2, "recovery must reload the current active goal after the EDT status conflict");
  assert.equal(retryOperations.some(operation => operation.collection === "agent-runtime" && operation.key === "active-goal"),
    false, "the subscription retry must preserve the newly started OST");
});

test("an EDT inbox settlement CAS conflict replays the durable event after clearing stale snapshots", () => {
  const records = new Map();
  const eventTask = {
    schemaVersion: 1, eventTaskId: "edt-inbox-cas", goalId: "g-edt-inbox-cas", taskId: "t-edt-inbox-cas",
    runId: "run-edt-inbox-cas", intent: "收到通知时只处理指定联系人", trigger: {
      kind: "notification", sourcePackages: ["com.tencent.mm"], description: "处理微信通知",
    }, state: "cancelled", revision: 3, createdAt: 10, updatedAt: 20, missedNotifications: 0, journalSequence: 0,
  };
  const active = { goalId: eventTask.goalId, taskId: eventTask.taskId, runId: eventTask.runId,
    intent: eventTask.intent, state: "event-driven", taskType: "event-driven", taskKind: "EDT",
    eventTaskId: eventTask.eventTaskId, progress: "事件任务已取消", createdAt: 10, revision: 3 };
  records.set("agent-runtime:active-goal", { value: active, revision: "active-r1" });
  records.set(`event-tasks:ed:${eventTask.eventTaskId}`, { value: eventTask, revision: "edt-r1" });
  const eventIds = Array.from({ length: 4 }, (_, index) => `notification:cancelled-cas-event-${index + 1}`);
  const inboxKeys = new Map(eventIds.map(eventId => [notificationInboxKey(eventId), eventId]));
  eventIds.forEach((eventId, index) => records.set(`inbox:${notificationInboxKey(eventId)}`, { value: {
    type: "notification.posted", eventId, subscriptionId: eventTask.eventTaskId,
    sourcePackage: "com.tencent.mm", occurredAt: 1_800_000_000_000 + index,
    receivedAt: 1_800_000_000_001 + index,
    notification: { title: "zhyuzh", text: "合成通知，取消后不应触发" }, state: "received",
  }, revision: `inbox-r${index + 1}` }));
  const conflictedEventIds = new Set();
  let settlementAttempts = 0;
  let modelCalls = 0;

  function tool(method, params) {
    if (method === "data.batch") {
      const settlement = params.operations.find(operation => operation.collection === "inbox" &&
        inboxKeys.has(operation.key) && operation.op === "delete");
      if (settlement) {
        settlementAttempts += 1;
        const eventId = inboxKeys.get(settlement.key);
        if (!conflictedEventIds.has(eventId)) {
          conflictedEventIds.add(eventId);
          return { __toolError: { code: "E_CONFLICT", message: "inbox revision changed" } };
        }
      }
      return persistMockBatch(records, params);
    }
    if (method === "data.put") {
      const revision = `put-r${Number(records.get(`${params.collection}:${params.key}`)?.revision?.slice(5) || 0) + 1}`;
      records.set(`${params.collection}:${params.key}`, { value: structuredClone(params.value), revision });
      return { revision };
    }
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") {
      return { items: [...records.entries()].filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
        .sort(([left], [right]) => left.localeCompare(right)).slice(0, params.limit)
        .map(([key, value]) => ({ key: key.slice(params.collection.length + 1), ...value })) };
    }
    if (method === "network.request") { modelCalls += 1; throw new Error("取消的 EDT 不应调用模型"); }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      const result = tool(call.method, call.params);
      output = result?.__toolError
        ? globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: result.__toolError })
        : globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "event-driven");
  const drained = deliver({ type: "worker.queue-drained" });
  assert.equal(drained.state, "event-driven");
  assert.equal(settlementAttempts, 8, "each conflict must rescan and settle its durable notification exactly once");
  for (const eventId of eventIds) {
    assert.equal(records.get(`agent-runtime:${eventReceiptKey(eventId)}`).value.state, "ignored");
    assert.equal(records.has(`inbox:${notificationInboxKey(eventId)}`), false);
  }
  assert.equal(modelCalls, 0);
});

test("a queued EDT cancellation is applied before startup drains old notifications", () => {
  const records = new Map();
  const eventTask = {
    schemaVersion: 1, eventTaskId: "edt-cancel-before-inbox", goalId: "g-edt-cancel-before-inbox",
    taskId: "t-edt-cancel-before-inbox", runId: "run-edt-cancel-before-inbox", intent: "收到新消息时按上下文处理",
    trigger: { kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到微信通知" },
    state: "active", revision: 1, createdAt: 10, updatedAt: 10, missedNotifications: 0, journalSequence: 0,
  };
  const active = { goalId: eventTask.goalId, taskId: eventTask.taskId, runId: eventTask.runId,
    intent: eventTask.intent, state: "event-driven", taskType: "event-driven", taskKind: "EDT",
    eventTaskId: eventTask.eventTaskId, progress: "事件任务已启用", createdAt: 10, revision: 1 };
  const notificationId = "notification:queued-before-cancel";
  const inboxKey = notificationInboxKey(notificationId);
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  records.set(`event-tasks:ed:${eventTask.eventTaskId}`, { value: eventTask, revision: "1" });
  records.set(`inbox:${inboxKey}`, { value: {
    type: "notification.posted", eventId: notificationId, subscriptionId: eventTask.eventTaskId,
    sourcePackage: "com.tencent.mm", occurredAt: 1_800_000_000_000, receivedAt: 1_800_000_000_001,
    notification: { title: "zhyuzh", text: "积压的合成测试消息" }, state: "received",
  }, revision: "1" });
  const sideEffects = [];
  let modelCalls = 0;
  let captures = 0;

  function tool(method, params) {
    if (method === "data.batch") {
      for (const operation of params.operations) {
        const key = `${operation.collection}:${operation.key}`;
        if (operation.op === "delete") records.delete(key);
        else records.set(key, { value: operation.value, revision: String(Number(records.get(key)?.revision || 0) + 1) });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, item]) => ({ key: key.slice(params.collection.length + 1), ...item })) };
    if (method === "notifications.unsubscribe") {
      sideEffects.push(method);
      return { ready: true, state: "unsubscribed", subscriptionId: params.subscriptionId, removed: 1 };
    }
    if (method === "interaction.capture") { captures += 1; throw new Error("cancelled EDT must not observe the screen"); }
    if (method === "network.request") { modelCalls += 1; throw new Error("cancelled EDT must not call the model"); }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      assert.equal(output.actions.length, 1);
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "event-driven");
  assert.ok(records.has(`inbox:${inboxKey}`), "startup must leave local notifications untouched until Host drains durable controls");
  const cancelled = deliver({ type: "event-task.control", eventId: "cancel-before-inbox-control",
    eventTaskId: eventTask.eventTaskId, command: "cancel" });
  assert.equal(cancelled.controlApplied, true);
  assert.equal(records.get(`event-tasks:ed:${eventTask.eventTaskId}`).value.state, "cancelled");
  assert.equal(records.has(`inbox:${inboxKey}`), true, "the notification is still queued until the Host queue-drained barrier");

  deliver({ type: "worker.queue-drained" });
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(notificationId)}`).value.state, "ignored");
  assert.equal(records.has(`inbox:${inboxKey}`), false);
  assert.equal(records.get("agent-runtime:active-goal").value.state, "event-driven");
  assert.equal([...records.keys()].filter(key => key.startsWith("goals:g:")).length, 1);
  assert.equal(modelCalls, 0);
  assert.equal(captures, 0);
  assert.deepEqual(sideEffects, ["notifications.unsubscribe"]);
});

test("automatic waits are clamped to the OST deadline and expiry is saved before another observation", () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const deadlineAt = now + 60_000;
  const active = {
    goalId: "goal-wait-deadline", taskId: "task-wait-deadline", runId: "run-wait-deadline",
    intent: "等待测试条件后继续", state: "running", step: 2, revision: 1, progress: "等待触发条件",
    goalAttemptStartedAt: now, goalDeadlineAt: deadlineAt, journalSequence: 0, trace: [],
    actionLoop: { index: 1, status: "running", budgetMinutes: 15, estimatedMinutes: 1,
      elapsedMs: 0, segmentStartedAt: null },
  };
  const records = new Map([["agent-runtime:active-goal", { value: active, revision: "1" }]]);
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let captures = 0;
  let scheduledWaitMs = null;

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`);
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" });
      return { revision: "2" };
    }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") { captures += 1; return { dataBase64: "synthetic-frame" }; }
    if (method === "network.request") return modelCall(params, () => ({
      state: "wait", evidence: "下一次检查前需要等待", waitMs: 15 * 60_000,
    }));
    if (method === "worker.wait") {
      scheduledWaitMs = params.ms;
      now = deadlineAt;
      return { waitedMs: params.ms };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  try {
    let output = globalThis.onHaminnEvent({ type: "start" });
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    const saved = records.get("agent-runtime:active-goal").value;
    assert.equal(scheduledWaitMs, 60_000, "a 15-minute model wait must stop at the 1-minute OST deadline");
    assert.equal(output.state, "failed");
    assert.equal(saved.state, "failed");
    assert.equal(captures, 1, "deadline expiry must stop before another screenshot or model action");
    assert.ok(saved.trace.some((event) => event.phase === "task.wait-scheduled" && event.scheduledMs === 60_000));
    assert.ok(saved.trace.some((event) => event.phase === "goal.time-limit-exceeded"));
  } finally {
    Date.now = originalNow;
  }
});

test("host OST timeout returns to HO, which persists failure without another screen effect", () => {
  const originalNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  const deadlineAt = now + 12 * 60_000;
  const records = new Map();
  records.set("agent-runtime:active-goal", { revision: "1", value: {
    goalId: "ost-host-deadline", taskId: "task-host-deadline", runId: "run-host-deadline",
    intent: "完成合成页面任务", state: "active", taskType: "one-shot", taskKind: "OST",
    createdAt: now, goalAttemptStartedAt: now, goalDeadlineAt: deadlineAt, step: 2, journalSequence: 0,
    actionLoop: { index: 1, status: "running", budgetMinutes: 15, elapsedMs: 0 }, trace: [],
  } });
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") return { revision: "2" };
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "2" });
      }
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "synthetic-frame" };
    throw new Error(`Unexpected tool before deadline-bearing effect: ${method}`);
  }

  try {
    let output = globalThis.onHaminnEvent({ type: "start" });
    let deadlineCall = null;
    for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
      const call = output.actions[0];
      if (call.method.startsWith("interaction.") || call.method === "network.request" || call.method === "files.readText") {
        deadlineCall = call;
        break;
      }
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }

    assert.ok(deadlineCall, "startup should reach the first external observation");
    assert.equal(deadlineCall.params.__haminnWorkerDeadlineAt, deadlineAt);

    now = deadlineAt;
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: deadlineCall.callId, ok: false,
      error: { code: "E_TIMEOUT", message: "OST 软件时限已到，宿主已取消当前外部操作", retryable: false } });
    for (let turn = 0; output?.actions?.length && turn < 8; turn += 1) {
      const call = output.actions[0];
      assert.equal(call.method, "data.batch", "HO may save its hard-time-limit result after expiry");
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    const saved = records.get("agent-runtime:active-goal")?.value;
    assert.equal(output.state, "failed");
    assert.equal(saved.state, "failed");
    assert.equal(saved.waiting.category, "goal-time-limit");
    assert.ok(saved.trace.some(event => event.phase === "goal.time-limit-exceeded"));
  } finally {
    Date.now = originalNow;
  }
});

test("a Worker restart recovers a dispatched Back from its prepared idempotency key without replay", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const callOrder = [];
  let modelTurn = 0;
  let captures = 0;
  let globalActions = 0;
  let statusPolls = 0;
  const decisions = [
    { state: "action", confidence: 0.98, evidence: "当前为联系人资料页，应返回聊天", action: { type: "back", target: "返回 WeChat 聊天" } },
    { state: "done", confidence: 0.98, operationResult: "verified", evidence: "截图显示目标聊天已恢复且输入框为空" },
  ];

  function tool(method, params) {
    callOrder.push({ method, params });
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "1" });
      }
      return mockBatchResult(params);
    }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") {
      captures += 1;
      return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    }
    if (method === "network.request") return modelCall(params, () => decisions[modelTurn++]);
    if (method === "interaction.globalAction") {
      globalActions += 1;
      return { action: "back", operationId: params.operationId, state: "scheduled", scheduledAt: Date.now(), finishedAt: null, error: null };
    }
    if (method === "interaction.globalActionStatus") {
      statusPolls += 1;
      return statusPolls === 1
        ? { found: true, action: "back", operationId: params.operationId, state: "scheduled", scheduledAt: Date.now(), finishedAt: null, error: null }
        : { found: true, action: "back", operationId: params.operationId, state: "accepted", scheduledAt: Date.now(), finishedAt: Date.now(), error: null };
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event, { stopAfterGlobalActionDispatch = false } = {}) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 64; turn += 1) {
      const call = output.actions[0];
      try {
        const result = tool(call.method, call.params);
        if (stopAfterGlobalActionDispatch && call.method === "interaction.globalAction") {
          return { output, interruptedAt: call, discardedResult: result };
        }
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
          error: { code: error.code, retryable: error.retryable, message: error.message } });
      }
    }
    return { output };
  }

  const first = deliver({ type: "goal.submit", intent: "从联系人资料页返回 zhyuzh 聊天并核验输入框为空" }, { stopAfterGlobalActionDispatch: true });
  assert.equal(first.interruptedAt?.method, "interaction.globalAction");
  assert.equal(globalActions, 1);
  const prepared = records.get("agent-runtime:active-goal").value;
  assert.equal(prepared.pendingGlobalAction, undefined, "the worker stopped before receiving the scheduled receipt");
  assert.equal(prepared.pendingOperation.status, "prepared");
  assert.equal(prepared.pendingOperation.bridgeOperationId, first.interruptedAt.params.operationId);
  assert.equal(first.discardedResult.state, "scheduled");

  // Simulate Worker recreation while the scheduled Android operation is still unresolved.
  const resumed = deliver({ type: "start" });
  assert.equal(resumed.output.state, "done", JSON.stringify(resumed.output));
  assert.equal(globalActions, 1, "resuming a receipt must never replay Back");
  assert.equal(statusPolls, 2);
  assert.equal(captures, 2, "capture once before the navigation decision and once after its accepted receipt");
  const methods = callOrder.map(call => call.method);
  const firstStatus = methods.indexOf("interaction.globalActionStatus");
  const finalCapture = methods.lastIndexOf("interaction.capture");
  assert.ok(firstStatus >= 0 && finalCapture > firstStatus);
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(saved.pendingGlobalAction, null);
  assert.ok(saved.trace.some(event => event.phase === "bridge.status-pending"));
  assert.ok(saved.trace.some(event => event.phase === "bridge.status-final" && event.status === "accepted"));
  assert.ok(saved.trace.some(event => event.phase === "bridge.receipt-recovered"));
});

test("an unresolved navigation receipt becomes unknown and returns control to visual LLM recovery", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let modelTurn = 0;
  let captures = 0;
  let globalActions = 0;
  let statusPolls = 0;
  const decisions = [
    { state: "action", confidence: 0.98, evidence: "应退出资料页", action: { type: "back", target: "返回聊天" } },
    { state: "done", confidence: 0.75, operationResult: "unknown", evidence: "状态回执超时后重新截图，我判断当前目标已达到" },
  ];

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") { captures += 1; return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" }; }
    if (method === "network.request") return modelCall(params, () => decisions[modelTurn++]);
    if (method === "interaction.globalAction") {
      globalActions += 1;
      return { action: "back", operationId: params.operationId, state: "scheduled", scheduledAt: Date.now() };
    }
    if (method === "interaction.globalActionStatus") {
      statusPolls += 1;
      return { found: true, action: "back", operationId: params.operationId, state: "scheduled", scheduledAt: Date.now() };
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 96; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  const result = deliver({ type: "goal.submit", intent: "从资料页返回聊天并检查页面状态" });
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(result.state, "done");
  assert.equal(globalActions, 1, "an uncertain receipt must not cause an automatic action replay");
  assert.equal(statusPolls, 8);
  assert.equal(captures, 2, "the LLM regains control only after a fresh screenshot");
  assert.equal(active.lastActionResult.status, "unknown");
  assert.equal(active.pendingGlobalAction, null);
  assert.ok(active.trace.some(event => event.phase === "bridge.status-final" && event.status === "unknown"));
});

test("screen effects persist a prepared receipt and require visual verification before completion", () => {
  const records = new Map();
  const callOrder = [];
  let modelTurn = 0;
  let firstTapCallId = null;
  const decisions = [
    { state: "action", confidence: 0.98, evidence: "合成页面显示唯一按钮", recipeUse: {
      sourceRef: "knowledge:tool-recipe:synthetic-tap", stepIndex: 0,
    }, action: { type: "tap", target: "合成测试按钮", label: "Continue", x: 0.5, y: 0.5 } },
    { state: "done", confidence: 0.99, operationResult: "verified", evidence: "截图显示按钮后的完成标记" },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    callOrder.push(method);
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "1" });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") return { revision: "1" };
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan" && params.prefix === "tool-recipe:") return { items: [{
      key: "tool-recipe:synthetic-tap", revision: "5", value: {
        type: "tool-recipe", state: "active", name: "合成页面点击后复核",
        purpose: "按屏幕证据使用合成按钮", steps: [
          { toolRef: "interaction.tap", purpose: "点击截图中唯一合成按钮" },
          { toolRef: "interaction.capture", purpose: "观察点击后的界面" },
        ],
      },
    }] };
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") return modelCall(params, () => decisions[modelTurn++]);
    if (method === "interaction.tap") {
      const operation = [...records.entries()].find(([key]) => key.startsWith("operations:o:o-"))?.[1]?.value;
      assert.equal(operation?.status, "prepared", "operation intent must be durable before the tap");
      return { accepted: true };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 32; turn += 1) {
      const call = output.actions[0];
      if (call.method === "interaction.tap") firstTapCallId = call.callId;
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  const result = deliver({ type: "goal.submit", intent: "点击合成测试按钮并确认完成" });
  assert.equal(result.state, "done", JSON.stringify({ result, records: [...records.entries()] }));
  const duplicate = globalThis.onHaminnEvent({ type: "tool.result", callId: firstTapCallId, ok: true, result: { accepted: true } });
  assert.equal(duplicate.actions[0].method, "data.batch");
  const duplicateSettled = globalThis.onHaminnEvent({ type: "tool.result", callId: duplicate.actions[0].callId, ok: true,
    result: tool("data.batch", duplicate.actions[0].params) });
  assert.equal(duplicateSettled.ignored, true);
  const operation = [...records.entries()].find(([key]) => key.startsWith("operations:o:o-"))?.[1]?.value;
  assert.equal(operation.status, "verified");
  assert.equal(operation.verificationEvidence, "截图显示按钮后的完成标记");
  assert.ok(callOrder.indexOf("data.batch") < callOrder.indexOf("interaction.tap"));
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(active.state, "done");
  const recipeDecision = active.trace.find(event => event.phase === "decision" && event.recipeUse);
  assert.deepEqual(recipeDecision.recipeUse, {
    sourceRef: "knowledge:tool-recipe:synthetic-tap", stepIndex: 0,
    toolRef: "interaction.tap", recordRevision: "5",
  });
  const phases = active.trace.map((event) => event.phase);
  for (const phase of ["screenshot.requested", "screenshot.received", "model.requested", "model.responded",
    "decision", "bridge.dispatched", "bridge.result"]) assert.ok(phases.includes(phase), `trace is missing ${phase}`);
  assert.ok(phases.indexOf("decision") < phases.indexOf("bridge.dispatched"));
  assert.ok(active.trace.every((event) => !("text" in event) && !("visibleContent" in event)));
  const journal = [...records.entries()].filter(([key]) => key.startsWith(`agent-events:e:${active.goalId}:`)).map(([, item]) => item.value);
  assert.equal(journal.length, active.journalSequence);
  assert.ok(journal.some((event) => event.phase === "bridge.result"));
  assert.ok(journal.some((event) => event.phase === "worker.stale-tool-result"));
});

test("input actions forward screenshot-normalized editor coordinates to the native Bridge", () => {
  const records = new Map();
  const inputCalls = [];
  let modelTurn = 0;
  const decisions = [
    { state: "action", evidence: "消息输入框位于截图中部偏下", action: {
      type: "input", target: "消息输入框", label: "正文", focused: true, mode: "replace",
      text: "synthetic test", x: 0.42, y: 0.61,
    } },
    { state: "done", operationResult: "verified", evidence: "合成正文已出现在输入框" },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.put") return { revision: "1" };
    if (method === "data.get") return params.key === "provider" ? { value: provider }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", width: 461, height: 1024, dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") return modelCall(params, () => decisions[modelTurn++]);
    if (method === "interaction.inputText") {
      inputCalls.push(params);
      return { accepted: true, targeting: "coordinates" };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 32; turn += 1) {
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  const result = deliver({ type: "goal.submit", intent: "在指定会话输入合成测试正文" });
  assert.equal(result.state, "done", JSON.stringify(result));
  assert.deepEqual(inputCalls.map(({ __haminnWorkerDeadlineAt, ...params }) => params),
    [{ text: "synthetic test", mode: "replace", x: 0.42, y: 0.61 }]);
  assert.ok(inputCalls[0].__haminnWorkerDeadlineAt > Date.now(), "the host receives an active OST deadline");
});

test("input conflict codes reach CAE recovery context and guide a fresh observation after refocus", () => {
  const records = new Map();
  const requests = [];
  let modelTurn = 0;
  let taps = 0;
  const decisions = [
    { state: "action", evidence: "截图中的消息编辑框", action: {
      type: "input", target: "消息编辑框", label: "正文", focused: true, mode: "replace", text: "synthetic test", x: 0.42, y: 0.61,
    } },
    { state: "action", evidence: "依据截图点击编辑框中心", action: {
      type: "tap", target: "消息编辑框", label: "聚焦输入框", x: 0.42, y: 0.61,
    }, operationResult: "not-executed" },
    { state: "done", operationResult: "verified", evidence: "合成输入实验流程已完成" },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.put") return { revision: "1" };
    if (method === "data.get") return params.key === "provider" ? { value: provider }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", width: 461, height: 1024, dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      requests.push(JSON.parse(params.bodyText));
      return modelCall(params, () => decisions[modelTurn++]);
    }
    if (method === "interaction.inputText") {
      throw Object.assign(new Error("截图坐标和当前焦点都没有可输入文字的控件"), { code: "E_CONFLICT", retryable: true });
    }
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 40; turn += 1) {
      const call = output.actions[0];
      try {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
          error: { code: error.code, retryable: error.retryable, message: error.message } });
      }
    }
    return output;
  }

  let result = deliver({ type: "goal.submit", intent: "在合成测试会话输入测试正文" });
  for (let attempt = 0; result.state === "waiting" && !result.userRequired && attempt < 3; attempt += 1) {
    result = deliver({ type: "tick" });
  }
  assert.equal(result.state, "done", JSON.stringify(result));
  const promptText = request => request.messages.map(message => typeof message.content === "string" ? message.content
    : message.content?.map?.(part => part.text || "").join(" ") || "").join("\n");
  assert.equal(taps, 1, "the LLM should choose and execute the recovery tap");
  assert.match(promptText(requests[0]), /确认截图覆盖目标内容的最新位置/);
  assert.match(promptText(requests[0]), /不能用旧内容推断最新状态或内容不存在/);
  assert.match(promptText(requests[2]), /E_CONFLICT/);
  assert.match(promptText(requests[2]), /不能靠微调相邻坐标反复 input/);
  assert.match(promptText(requests[3]), /已点击编辑框，必须先检查这次点击后的新截图/);
  const active = records.get("agent-runtime:active-goal").value;
  assert.ok(active.trace.some(event => event.phase === "worker.error" && event.code === "E_CONFLICT"));
});

test("clipboard input recovery is model-selected after refocus and requires visual paste verification", () => {
  const records = new Map();
  const requests = [];
  const inputCalls = [];
  let modelTurn = 0;
  const decisions = [
    { state: "action", evidence: "截图中的消息编辑框", action: {
      type: "input", target: "消息编辑框", label: "正文", focused: true, mode: "replace", text: "synthetic test", x: 0.46, y: 0.94,
    } },
    { state: "action", evidence: "重新点击编辑框中心", operationResult: "not-executed", action: { type: "tap", target: "消息编辑框", label: "聚焦输入框", x: 0.46, y: 0.94 } },
    { state: "action", evidence: "截图确认输入框和键盘可见，无障碍输入仍不可用", action: {
      type: "input", target: "消息编辑框", label: "正文", focused: true, mode: "replace", text: "synthetic test", x: 0.46, y: 0.94,
    }, operationResult: "not-executed" },
    { state: "action", evidence: "重新观察后确认 Bridge 仍无法定位编辑控件，改走系统粘贴菜单", operationResult: "not-executed", action: {
      type: "input", inputStrategy: "clipboard-paste", target: "消息编辑框", label: "正文", focused: true,
      mode: "replace", text: "synthetic test", x: 0.46, y: 0.94,
    } },
    { state: "action", evidence: "截图中看到粘贴菜单", operationResult: "not-executed", action: { type: "tap", target: "粘贴菜单", label: "粘贴", x: 0.3, y: 0.89 } },
    { state: "done", operationResult: "verified", evidence: "截图确认正文正确，合成输入任务完成" },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.put") return { revision: "1" };
    if (method === "data.get") return params.key === "provider" ? { value: provider }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", width: 461, height: 1024, dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      requests.push(JSON.parse(params.bodyText));
      return modelCall(params, () => decisions[modelTurn++]);
    }
    if (method === "interaction.inputText") {
      inputCalls.push(params);
      if (params.clipboardFallback) return { accepted: true, completed: true, entered: false, targeting: "clipboard-paste-prepared" };
      throw Object.assign(new Error("截图坐标和当前焦点都没有可输入文字的控件"), { code: "E_CONFLICT", retryable: true });
    }
    if (method === "interaction.tap") return { accepted: true, completed: true };
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 48; turn += 1) {
      const call = output.actions[0];
      try {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
          error: { code: error.code, retryable: error.retryable, message: error.message } });
      }
    }
    return output;
  }

  let result = deliver({ type: "goal.submit", intent: "在合成测试会话输入测试正文" });
  for (let attempt = 0; result.state === "waiting" && !result.userRequired && attempt < 8; attempt += 1) result = deliver({ type: "tick" });
  assert.equal(result.state, "done", JSON.stringify(result));
  assert.equal(inputCalls.length, 3, JSON.stringify({ result, modelTurn, requests: requests.length, recovery: records.get("agent-runtime:active-goal")?.value?.inputRecovery,
    trace: records.get("agent-runtime:active-goal")?.value?.trace?.slice(-15) }));
  assert.equal(inputCalls[0].clipboardFallback, undefined);
  assert.equal(inputCalls[1].clipboardFallback, undefined);
  assert.equal(inputCalls[2].clipboardFallback, true);
  const promptText = request => request.messages.map(message => typeof message.content === "string" ? message.content
    : message.content?.map?.(part => part.text || "").join(" ") || "").join("\n");
  assert.match(promptText(requests[4]), /inputStrategy=clipboard-paste/);
  assert.match(promptText(requests[5]), /不能视为已粘贴/);
  assert.match(promptText(requests[5]), /如果输入框已有旧内容或混合正文，先点“全选”，再点“粘贴”/);
  assert.match(promptText(requests[5]), /不要再次调用普通 inputText/);
  const active = records.get("agent-runtime:active-goal").value;
  assert.ok(active.trace.some(event => event.phase === "bridge.result" && event.targeting === "clipboard-paste-prepared"));
  assert.equal(active.inputRecovery.stage, "paste-menu-pending");
  assert.equal(active.inputRecovery.mode, "replace");
});

test("the LLM may report completion with an uncertain effect and the Worker records its judgment", () => {
  const records = new Map();
  let modelTurn = 0;
  let taps = 0;
  const decisions = [
    { state: "action", confidence: 0.98, evidence: "合成页面显示按钮", action: { type: "tap", target: "合成按钮", label: "Continue", x: 0.5, y: 0.5 } },
    { state: "done", confidence: 0.98, operationResult: "unknown", evidence: "结合目标和操作历史，我判断任务已经完成" },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") return modelCall(params, () => decisions[modelTurn++]);
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 32; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  const result = deliver({ type: "goal.submit", intent: "完成合成任务" });
  const operation = [...records.entries()].find(([key]) => key.startsWith("operations:o:o-"))?.[1]?.value;
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(result.state, "done");
  assert.equal(taps, 1);
  assert.equal(operation.status, "unknown");
  assert.equal(active.pendingOperationId, operation.operationId);
  assert.equal(active.progress, "结合目标和操作历史，我判断任务已经完成");
  assert.ok(active.trace.some((event) => event.phase === "screen.unchanged"));
});

test("malformed actions recover and the LLM completion judgment is stored without a confidence threshold", () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const prompts = [];
  let taps = 0;
  let modelCalls = 0;

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      prompts.push(body.messages.map(message => typeof message.content === "string" ? message.content
        : message.content?.map?.(part => part.text || "").join(" ") || "").join("\n"));
      return modelCall(params, () => {
        modelCalls += 1;
        return modelCalls === 1
          ? { state: "action", evidence: "合成页面显示按钮", action: { type: "tap", target: "合成按钮" } }
          : modelCalls === 2
            ? { state: "action", evidence: "重新截图后仍无法确认合成目标", action: { type: "tap", target: "合成按钮", x: 1.2, y: 0.5 } }
            : modelCalls === 3
              ? { state: "action", confidence: 0.12, evidence: "换用坐标路径继续完成合成操作", action: { type: "tap", target: "合成按钮", x: 0.5, y: 0.5 } }
              : { state: "done", confidence: 0.01, operationResult: "verified", evidence: "根据最终画面和操作历史，我判断合成目标已完成" };
      });
    }
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 32; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle", "load an empty test store to isolate this task");
  const first = deliver({ type: "goal.submit", intent: "点击合成测试按钮" });
  assert.equal(first.state, "waiting", "recovery must yield the current event before retrying");
  assert.equal(modelCalls, 1);
  const second = deliver({ type: "tick" });
  assert.equal(second.state, "waiting", "a repeated invalid action must back off and yield again");
  assert.equal(modelCalls, 2);
  const result = deliver({ type: "tick" });
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(result.state, "done");
  assert.equal(taps, 1, "a valid LLM action is not vetoed by a program confidence threshold");
  assert.equal(modelCalls, 4);
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "done");
  assert.equal(active.state, "done");
  assert.equal(active.recoverySignals.total, 2, "cumulative failures survive subsequent valid model decisions");
  assert.equal(active.recoverySignals.categories[0].stage, "provider-result");
  assert.equal(active.recoverySignals.categories[0].count, 2);
  assert.ok(prompts.some(prompt => /本 OST 累计模型\/屏幕故障 2 次/.test(prompt)),
    "the LLM sees cumulative recovery failures on a later action request");
  assert.equal(active.trace.find((event) => event.phase === "decision" && event.decision === "done")?.evidence,
    "根据最终画面和操作历史，我判断合成目标已完成");
  assert.equal(Object.hasOwn(active.trace.find((event) => event.phase === "decision" && event.decision === "done"), "confidence"), false);
  assert.equal(active.trace.filter((event) => event.phase === "model.error").length, 2);
  assert.ok(active.trace.some((event) => event.phase === "recovery.scheduled" && event.mode === "yield-and-reobserve"));
  assert.ok(active.trace.some((event) => event.phase === "recovery.scheduled" && event.mode === "backoff"));
});

test("retryable runtime bridge failures survive Worker restart and reobserve through the LLM", async () => {
  const records = new Map();
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const prompts = [];
  let failExperienceScan = true;

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") {
      if (params.collection === "knowledge" && params.prefix === "experience:" && failExperienceScan) {
        failExperienceScan = false;
        throw Object.assign(new Error("synthetic transient store network failure"), { code: "E_NETWORK", retryable: true });
      }
      return { items: [] };
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      prompts.push(body.messages.map(message => typeof message.content === "string" ? message.content
        : message.content?.map?.(part => part.text || "").join(" ") || "").join("\n"));
      return modelCall(params, () => ({ state: "done", evidence: "重新观察后，LLM 判断合成目标已完成" }));
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 48; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
        error: { code: error.code, retryable: error.retryable, message: error.message } }); }
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  const interrupted = deliver({ type: "goal.submit", intent: "完成合成任务" });
  const waitingState = records.get("agent-runtime:active-goal").value;
  assert.equal(interrupted.state, "waiting");
  assert.equal(interrupted.userRequired, undefined, "transient runtime failures recover automatically");
  assert.equal(waitingState.lastDecision?.state, undefined, "a Worker error must not be fabricated as an LLM stop decision");
  assert.equal(waitingState.recoverySignals.total, 1);
  assert.equal(waitingState.recoverySignals.categories[0].stage, "knowledge-scan");
  assert.ok(waitingState.trace.some(event => event.phase === "recovery.scheduled" && event.mode === "runtime-reobserve"));

  await import(`./worker.mjs?recovery-restart=${Date.now()}`);
  const completed = deliver({ type: "start" });
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(completed.state, "done");
  assert.equal(active.state, "done");
  assert.equal(active.recoverySignals.total, 1, "successful LLM decisions preserve the failure history");
  assert.ok(prompts.some(prompt => /本 OST 累计模型\/屏幕故障 1 次/.test(prompt)),
    "the LLM receives the runtime failure before deciding how to continue");
  assert.equal(active.trace.some(event => event.phase === "decision" && event.decision === "stop"), false);
});

test("post-completion queue read errors are logged and retried without reopening the completed OST", async () => {
  await import(`./worker.mjs?post-task-queue-recovery=${Date.now()}`);
  const active = { goalId: "goal-finished", taskId: "task-finished", runId: "run-finished",
    intent: "完成合成任务", state: "done", step: 2, revision: 4, progress: "LLM 已判断任务完成", trace: [] };
  const records = new Map([[
    "agent-runtime:active-goal", { value: active, revision: "1" },
  ]]);
  let failedQueueReads = 1;

  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan" && params.collection === "inbox" && params.prefix === "q:") {
      if (failedQueueReads-- > 0) {
        throw Object.assign(new Error("synthetic queue store outage"), { code: "E_NETWORK", retryable: true });
      }
      return { items: [] };
    }
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" });
      return { revision: "2" };
    }
    if (method === "data.batch") {
      for (const operation of params.operations) records.set(`${operation.collection}:${operation.key}`,
        { value: operation.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(output) {
    for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
      const call = output.actions[0];
      try {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId,
          ok: true, result: tool(call.method, call.params) });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
          error: { code: error.code, retryable: error.retryable, message: error.message } });
      }
    }
    return output;
  }

  const loaded = deliver(globalThis.onHaminnEvent({ type: "start" }));
  assert.equal(loaded.state, "done");
  const afterFailure = deliver(globalThis.onHaminnEvent({ type: "tick" }));

  assert.equal(afterFailure.state, "done");
  assert.equal(afterFailure.postTaskRetryScheduled, true);
  const savedAfterFailure = records.get("agent-runtime:active-goal").value;
  assert.equal(savedAfterFailure.state, "done", "queue recovery must not reopen the completed OST");
  assert.equal(savedAfterFailure.postTaskQueueRecovery.state, "retrying");
  assert.equal(savedAfterFailure.postTaskQueueRecovery.attempts, 1);
  assert.ok(savedAfterFailure.trace.some(event => event.phase === "worker.queue-recovery-scheduled"));

  const afterRetry = deliver(globalThis.onHaminnEvent({ type: "tick" }));
  const savedAfterRetry = records.get("agent-runtime:active-goal").value;
  assert.equal(afterRetry.state, "done");
  assert.equal(savedAfterRetry.state, "done");
  assert.equal(savedAfterRetry.postTaskQueueRecovery.state, "recovered");
  assert.equal(savedAfterRetry.postTaskQueueRecovery.attempts, 0);
  assert.ok(savedAfterRetry.trace.some(event => event.phase === "worker.queue-recovery-succeeded"));
});

test("background queue recovery stops after bounded retries and restarts without changing the completed OST", async () => {
  await import(`./worker.mjs?post-task-queue-exhaustion=${Date.now()}`);
  const active = { goalId: "goal-finished-retries", taskId: "task-finished-retries", runId: "run-finished-retries",
    intent: "完成合成任务", state: "done", step: 2, revision: 4, progress: "LLM 已判断任务完成", trace: [] };
  const records = new Map([[
    "agent-runtime:active-goal", { value: active, revision: "1" },
  ]]);
  let failedQueueReads = 8;

  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan" && params.collection === "inbox" && params.prefix === "q:" && failedQueueReads > 0) {
      failedQueueReads -= 1;
      throw Object.assign(new Error("synthetic queue store outage"), { code: "E_NETWORK", retryable: true });
    }
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" });
      return { revision: "2" };
    }
    if (method === "data.batch") {
      for (const operation of params.operations) records.set(`${operation.collection}:${operation.key}`,
        { value: operation.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(output) {
    for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
      const call = output.actions[0];
      try {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId,
          ok: true, result: tool(call.method, call.params) });
      } catch (error) {
        output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false,
          error: { code: error.code, retryable: error.retryable, message: error.message } });
      }
    }
    return output;
  }

  assert.equal(deliver(globalThis.onHaminnEvent({ type: "start" })).state, "done");
  let result;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    result = deliver(globalThis.onHaminnEvent({ type: "tick" }));
    assert.equal(result.state, "done");
    assert.equal(Boolean(result.userRequired), attempt === 8);
  }
  let saved = records.get("agent-runtime:active-goal").value;
  assert.equal(saved.state, "done");
  assert.equal(saved.postTaskQueueRecovery.state, "needs-user");
  assert.equal(saved.postTaskQueueRecovery.attempts, 8);
  assert.ok(saved.trace.some(event => event.phase === "worker.queue-recovery-needs-user"));

  const restarted = deliver(globalThis.onHaminnEvent({ type: "start" }));
  saved = records.get("agent-runtime:active-goal").value;
  assert.equal(restarted.state, "done");
  assert.equal(restarted.queueRecoveryRetry, true);
  assert.equal(saved.state, "done");
  assert.equal(saved.postTaskQueueRecovery.state, "retrying");
  assert.equal(saved.postTaskQueueRecovery.attempts, 0);
});

test("restarting a completed Worker resets exhausted background queue recovery without changing the OST result", async () => {
  await import(`./worker.mjs?post-task-queue-restart=${Date.now()}`);
  const active = { goalId: "goal-finished-recovery", taskId: "task-finished-recovery", runId: "run-finished-recovery",
    intent: "完成合成任务", state: "done", step: 2, revision: 4, progress: "LLM 已判断任务完成", trace: [],
    postTaskQueueRecovery: { kind: "inbox-drain", state: "needs-user", attempts: 8, maxAttempts: 8,
      userRequired: true, stage: "queue-read", error: "synthetic repeated storage outage" } };
  const records = new Map([[
    "agent-runtime:active-goal", { value: active, revision: "1" },
  ]]);

  const start = globalThis.onHaminnEvent({ type: "start" });
  const loaded = globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId, ok: true,
    result: records.get("agent-runtime:active-goal") });
  assert.equal(loaded.actions[0].method, "data.batch");
  for (const operation of loaded.actions[0].params.operations) records.set(`${operation.collection}:${operation.key}`,
    { value: operation.value, revision: "2" });
  const saved = globalThis.onHaminnEvent({ type: "tool.result", callId: loaded.actions[0].callId, ok: true,
    result: mockBatchResult(loaded.actions[0].params) });

  assert.equal(saved.state, "done");
  assert.equal(saved.startup, true);
  const recovered = records.get("agent-runtime:active-goal").value;
  assert.equal(recovered.state, "done");
  assert.equal(recovered.postTaskQueueRecovery.state, "retrying");
  assert.equal(recovered.postTaskQueueRecovery.userRequired, false);
  assert.equal(recovered.postTaskQueueRecovery.attempts, 0);
  assert.ok(recovered.trace.some(event => event.phase === "worker.queue-recovery-retry-requested"));
});

test("state write failure interrupts delivery without recursively retrying the same write", () => {
  let batchCalls = 0;

  function tool(method, params) {
    if (method === "data.get") return null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.batch") {
      batchCalls += 1;
      throw Object.assign(new Error("synthetic persistent storage failure"), { code: "E_STORAGE", retryable: true });
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 8; turn += 1) {
      const call = output.actions[0];
      let result;
      let bridgeError = null;
      try { result = tool(call.method, call.params); } catch (error) { bridgeError = error; }
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: !bridgeError,
        ...(bridgeError ? { error: { code: bridgeError.code, retryable: bridgeError.retryable, message: bridgeError.message } } : { result }) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  assert.throws(() => deliver({ type: "goal.submit", eventId: "synthetic-submit", intent: "完成合成任务" }), error => {
    assert.equal(error.category, "worker-state-persistence");
    assert.match(error.message, /持久化失败/);
    return true;
  });
  assert.equal(batchCalls, 1, "a failed checkpoint is not recursively written again");
});

test("failure to read a durable goal receipt interrupts delivery before acknowledging it", () => {
  let failReceiptRead = false;

  function tool(method, params) {
    if (method === "data.get") {
      if (failReceiptRead && params.key.startsWith("event:")) {
        throw Object.assign(new Error("synthetic receipt-store outage"), { code: "E_STORAGE", retryable: true });
      }
      return null;
    }
    if (method === "data.batch") return mockBatchResult(params);
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 8; turn += 1) {
      const call = output.actions[0];
      let result;
      let bridgeError = null;
      try { result = tool(call.method, call.params); } catch (error) { bridgeError = error; }
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: !bridgeError,
        ...(bridgeError ? { error: { code: bridgeError.code, retryable: bridgeError.retryable, message: bridgeError.message } } : { result }) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "idle");
  failReceiptRead = true;
  assert.throws(() => deliver({ type: "goal.submit", eventId: "synthetic-submit-read", intent: "完成合成任务" }), error => {
    assert.equal(error.category, "worker-state-persistence");
    assert.equal(error.code, "E_STORAGE");
    return true;
  });
});

test("recovery gives the model pending operation details and does not replay an unknown effect", () => {
  const records = new Map();
  const intendedContent = "synthetic recovery text ".repeat(70);
  const active = {
    goalId: "goal-recovery", taskId: "task-recovery", runId: "run-recovery",
    intent: "核实合成消息操作，不要重复发送", state: "active", step: 3, revision: 4,
    progress: "消息操作回执待核实", pendingOperationId: "operation-recovery",
    pendingOperation: {
      operationId: "operation-recovery", status: "returned", kind: "send", target: "Synthetic contact",
      label: "Send", intendedContent, result: { accepted: true },
    },
  };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const prompts = [];
  let actionRequests = 0;
  let taps = 0;

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" });
      return { revision: "2" };
    }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      const userContent = body.messages[1].content;
      const text = Array.isArray(userContent) ? userContent[0]?.text || "" : String(userContent || "");
      if (!text.includes("判断是否值得保存经验")) prompts.push(text);
      return modelCall(params, () => {
        if (text.includes("在本 AL 开始任何屏幕动作前")) {
          return { estimatedMinutes: 5, budgetMinutes: 15, strategy: "核实现场并继续" };
        }
        if (text.includes("判断是否值得保存经验")) return { saveExperience: false, saveTool: false };
        actionRequests += 1;
        return actionRequests === 1
          ? { state: "action", operationResult: "unknown", evidence: "旧发送仍无法确认，先观察合成界面", action: { type: "tap", target: "Synthetic status control", label: "刷新", x: 0.5, y: 0.5 } }
          : { state: "done", operationResult: "verified", evidence: "当前合成状态已核对，任务完成" };
      });
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 64; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  const result = deliver({ type: "start" });
  assert.equal(result.state, "done");
  assert.ok(prompts.length >= 3, "the resumed task should plan, act, and then observe the new action");
  assert.match(prompts[1], /"status":"returned"/);
  assert.match(prompts[1], /Synthetic contact/);
  assert.ok(prompts[1].includes(intendedContent), "recovery context must preserve the full allowed draft length");
  assert.match(prompts[2], /operation-recovery/);
  assert.match(prompts[2], /"status":"unknown"/);
  assert.match(prompts[2], /Bridge accepted 不等于界面效果已发生/);
  assert.equal(taps, 1, "the previously uncertain external send must not be replayed");
  assert.equal(records.get("operations:o:operation-recovery").value.status, "unknown");
  const recovered = records.get("agent-runtime:active-goal").value;
  assert.equal(recovered.pendingOperationId, null);
  assert.deepEqual(recovered.pendingOperations.map(item => item.operationId), ["operation-recovery"]);
});

test("paused goals stay paused on Worker start and accept new goals into the queue", () => {
  const records = new Map();
  const paused = { goalId: "goal-paused", taskId: "task-paused", runId: "run-paused",
    intent: "继续观察合成测试画面", state: "paused", step: 1, progress: "用户已暂停任务" };
  records.set("agent-runtime:active-goal", { value: paused, revision: "1" });
  let captures = 0;

  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "interaction.capture") { captures += 1; return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" }; }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 16; turn += 1) {
      const call = output.actions[0];
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "paused");
  assert.equal(captures, 0, "a paused goal must not observe or act until explicitly resumed");
  assert.equal(records.get("agent-runtime:active-goal").value.state, "paused");
  assert.equal(deliver({ type: "goal.submit", intent: "新的合成目标" }).state, "queued");
  assert.equal(captures, 0);
});

test("an already-running Worker accepts an explicit resume event for a paused Goal", () => {
  const records = new Map();
  const active = { goalId: "goal-resume", taskId: "task-resume", runId: "run-resume",
    intent: "完成合成任务", state: "paused", step: 2, revision: 3, progress: "已保存进度", waiting: { reason: "用户已暂停" },
    pendingAction: { type: "input", target: "消息编辑框" },
    trace: [{ phase: "worker.error", stage: "action-result", step: 2, message: "截图坐标和当前焦点都没有可输入文字的控件" }] };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let captures = 0;
  const calls = [];
  const modelRequests = [];

  function tool(method, params) {
    if (method === "data.get") { calls.push(`get:${params.key}`); return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null; }
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" }); return { revision: "2" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") { captures += 1; calls.push("capture"); return { mime: "image/jpeg", dataBase64: "synthetic-frame" }; }
    if (method === "network.request") { modelRequests.push(params.bodyText); return modelCall(params, () => ({ state: "done", evidence: "截图确认合成任务已完成" })); }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  assert.equal(deliver({ type: "start" }).state, "paused");
  const result = deliver({ type: "goal.resume" });
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(result.state, "done");
  assert.equal(saved.state, "done");
  assert.equal(captures, 1, "resume must reobserve before any external action");
  assert.ok(calls.indexOf("get:provider") >= 0 && calls.indexOf("get:provider") < calls.indexOf("capture"),
    "a resumed Worker must reload its model provider before it observes again");
  assert.ok(modelRequests.some(request => request.includes("输入故障恢复：Bridge 返回 E_CONFLICT")),
    "a restarted Worker should reconstruct the recovery context from a legacy trace without an error code");
});

test("action loop timeout invokes LLM review and can extend the current action loop instead of failing the task", () => {
  const records = new Map();
  const now = Date.now();
  const active = { goalId: "goal-budget", taskId: "task-budget", runId: "run-budget",
    intent: "完成合成任务", state: "running", step: 9000, revision: 9, progress: "仍在确认合成结果",
    actionLoop: { index: 2, status: "running", budgetMinutes: 15, estimatedMinutes: 15, elapsedMs: 15 * 60_000, segmentStartedAt: null } };
  records.set("agent-runtime:active-goal", { value: active, revision: "4" });
  let captures = 0;
  let reviewCalls = 0;

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" } } : records.get(`${params.collection}:${params.key}`);
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "5" }); return { revision: "5" }; }
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") { captures += 1; return { dataBase64: "synthetic" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "5" });
      return mockBatchResult(params);
    }
    if (method === "network.request") {
      const body = JSON.parse(params.bodyText);
      const content = body.messages[1].content;
      const prompt = Array.isArray(content) ? content[0]?.text || "" : String(content || "");
      if (prompt.includes("本 AL 已到预算检查点")) reviewCalls += 1;
      return modelCall(params, () => ({ state: "done", evidence: "LLM 根据最终截图判断合成任务已完成" }));
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 30; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(output.state, "done");
  assert.equal(saved.state, "done");
  assert.equal(reviewCalls, 1);
  assert.equal(saved.trace.find(event => event.phase === "action-loop.review")?.choice, "continue");
  assert.equal(saved.actionLoop.extensionCount, 1);
  assert.equal(saved.goalId, active.goalId);
  assert.equal(captures, 2, "timeout review and resumed work both observe the screen");
});

test("an action response arriving after the AL budget is reviewed before any new action is dispatched", () => {
  const records = new Map();
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  const active = { goalId: "goal-late-action", taskId: "task-late-action", runId: "run-late-action",
    taskType: "one-shot", taskKind: "OST", intent: "完成合成任务", state: "running", step: 4, revision: 5,
    createdAt: now - 1000, goalAttemptStartedAt: now - 1000, goalDeadlineAt: now + 10 * 60_000,
    progress: "观察合成界面", activeElapsedMs: 0, activeSegmentStartedAt: now,
    actionLoop: { index: 1, status: "running", budgetMinutes: 1, estimatedMinutes: 1, elapsedMs: 0, segmentStartedAt: now } };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  let captures = 0;
  let reviewCalls = 0;
  let actionCalls = 0;
  let taps = 0;
  const requestTimeouts = [];

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider"
      ? { value: { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" } }
      : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" }); return { revision: "2" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") { captures += 1; return { mime: "image/jpeg", dataBase64: "synthetic-frame" }; }
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
    if (method === "network.request") {
      requestTimeouts.push(params.timeoutMs);
      const body = JSON.parse(params.bodyText);
      const userText = body.messages[1].content;
      const prompt = Array.isArray(userText) ? userText.map(part => part.text || "").join("\n") : String(userText || "");
      if (prompt.includes("本 AL 已到预算检查点")) reviewCalls += 1;
      if (!prompt.includes("本 AL 已到预算检查点") && !prompt.includes("判断是否值得保存经验")) actionCalls += 1;
      const result = modelCall(params, () => actionCalls === 1
        ? { state: "action", evidence: "继续尝试一个新的合成界面动作", action: { type: "tap", target: "Synthetic button", label: "Continue", x: 0.5, y: 0.5 } }
        : { state: "done", evidence: "复盘后重新观察，合成目标已完成" });
      if (actionCalls === 1) now += 61_000;
      return result;
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 80; turn += 1) {
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  try {
    Date.now = () => now;
    const output = deliver({ type: "start" });
    const saved = records.get("agent-runtime:active-goal").value;
    assert.equal(output.state, "done");
    assert.equal(reviewCalls, 1);
    assert.equal(taps, 0, "the action returned after the AL budget must not be dispatched before review");
    assert.ok(captures >= 3, "the Worker should observe before the action, during review, and after resuming");
    assert.equal(saved.trace.some(event => event.phase === "action-loop.action-decision-deferred"), true);
    assert.equal(saved.trace.find(event => event.phase === "action-loop.review")?.choice, "continue");
    assert.ok(requestTimeouts.every(timeout => timeout <= 55_000), "provider requests must retain their normal upper bound");
  } finally {
    Date.now = originalNow;
  }
});

test("LLM can start a new action loop after timeout and choose a reusable experience after success", () => {
  const records = new Map();
  const memoryTrace = { at: Date.now() - 1000, step: 6, phase: "decision", decision: "action", evidence: "小明提到下周想讨论旅行计划" };
  const active = { goalId: "goal-new-action-loop", taskId: "task-new-action-loop", runId: "run-new-action-loop",
    intent: "完成合成任务", state: "running", step: 7, revision: 9, progress: "当前路径耗时较长",
    actionLoop: { index: 2, status: "running", budgetMinutes: 15, estimatedMinutes: 15, elapsedMs: 15 * 60_000, segmentStartedAt: null }, trace: [memoryTrace] };
  records.set("agent-runtime:active-goal", { value: active, revision: "4" });
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`);
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "5" }); return { revision: "5" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "5" });
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "synthetic-frame" };
    if (method === "network.request") return modelCall(params, () => ({ state: "done", evidence: "LLM 根据最终画面判断任务已完成" }), {
      review: { choice: "new-action-loop", reason: "已有进展但当前路径低效", nextStrategy: "重新评估页面入口后继续" },
      learning: {
        saveExperience: true,
        experience: { title: "合成页面直接入口", situation: "合成测试页操作", approach: "先观察当前页面，再使用可见入口", successEvidence: "最终页面显示完成状态", toolRefs: ["interaction.capture", "interaction.tap"] },
        savePattern: true,
        pattern: { title: "简洁回复", condition: "给朋友回消息", guidance: "表达自然，不必复述对方原文", evidence: "成功任务中用户采用此表达方式" },
        saveMemory: true,
        memories: [{ kind: "episode", objectRefs: ["contact:小明"], content: "小明提到下周想讨论旅行计划。", inference: "observed", tags: ["旅行"], sourceRefs: [memorySourceRef(active.goalId, memoryTrace)] }],
        saveTool: true,
        tool: { name: "页面入口复核", description: "观察页面后选择已注册的交互工具", toolRefs: ["interaction.tap", "shell.exec"] },
        saveRecipe: true,
        recipe: { name: "合成页面可见入口操作", purpose: "观察合成界面后按证据推进", applicability: "页面显示目标按钮且对象明确",
          sourceRefs: [memorySourceRef(active.goalId, memoryTrace)], steps: [
          { toolRef: "interaction.capture", purpose: "观察当前页面和目标对象" },
          { toolRef: "interaction.tap", purpose: "只点击截图中确认的目标入口" },
          { toolRef: "interaction.capture", purpose: "重新观察操作结果" },
        ] },
      },
    });
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 40; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(output.state, "done");
  assert.equal(saved.actionLoop.index, 3);
  assert.equal(saved.trace.find(event => event.phase === "action-loop.review")?.choice, "new-action-loop");
  assert.equal(records.get(`knowledge:experience:${active.goalId}`).value.type, "experience");
  assert.deepEqual(records.get(`self-model:bp:${active.goalId}`).value, {
    schemaVersion: 1, type: "behavior-pattern", state: "active", scope: "global",
    title: "简洁回复", condition: "给朋友回消息", guidance: "表达自然，不必复述对方原文",
    evidence: "成功任务中用户采用此表达方式", sourceGoalId: active.goalId,
    createdAt: records.get(`self-model:bp:${active.goalId}`).value.createdAt,
  });
  assert.deepEqual(records.get(`knowledge:tool-candidate:${active.goalId}`).value.toolRefs, ["interaction.tap"]);
  const savedRecipe = records.get(`knowledge:tool-recipe:${active.goalId}`).value;
  assert.equal(savedRecipe.type, "tool-recipe");
  assert.equal(savedRecipe.state, "active");
  assert.equal(savedRecipe.sourceGoalId, active.goalId);
  assert.deepEqual(savedRecipe.steps.map(step => step.toolRef), ["interaction.capture", "interaction.tap", "interaction.capture"]);
  assert.deepEqual(savedRecipe.sourceRefs, [memorySourceRef(active.goalId, memoryTrace)]);
  const memory = records.get(`knowledge:memory:${active.goalId}:1`).value;
  assert.equal(memory.type, "memory");
  assert.equal(memory.objectRefs[0], "contact:小明");
  assert.equal(memory.inference, "observed");
  assert.deepEqual(memory.sourceRefs, [memorySourceRef(active.goalId, memoryTrace)]);
});

test("the 30-minute deadline records an in-flight navigation receipt then stops before another observation", () => {
  const records = new Map();
  const operationId = "ga-deadline";
  const active = { goalId: "goal-deadline", taskId: "task-deadline", runId: "run-deadline",
    intent: "完成一个合成操作", state: "running", step: 4, revision: 5, progress: "等待本轮结果",
    createdAt: Date.now() - 31 * 60_000, goalAttemptStartedAt: Date.now() - 31 * 60_000,
    goalDeadlineAt: Date.now() - 60_000, actionLoop: { index: 1, status: "running", budgetMinutes: 15, elapsedMs: 2 * 60_000 },
    pendingAction: { type: "back", target: "返回聊天" },
    pendingOperationId: operationId,
    pendingOperation: { operationId, status: "scheduled", kind: "back", target: "返回聊天" },
    pendingGlobalAction: { operationId, action: "back", state: "scheduled", scheduledAt: Date.now() - 1000, polls: 0 },
  };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  let captures = 0;
  let modelCalls = 0;
  let statusCalls = 0;

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" } } : records.get(`${params.collection}:${params.key}`);
    if (method === "data.scan") return { items: [] };
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return mockBatchResult(params);
    }
    if (method === "interaction.capture") { captures += 1; return { dataBase64: "synthetic" }; }
    if (method === "network.request") { modelCalls += 1; return modelCall(params, () => ({ state: "done", evidence: "done" })); }
    if (method === "interaction.globalActionStatus") {
      statusCalls += 1;
      return { found: true, action: "back", operationId, state: "accepted", scheduledAt: Date.now() - 1000, finishedAt: Date.now(), error: null };
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(output.state, "failed");
  assert.equal(output.userRequired, true);
  assert.equal(saved.state, "failed");
  assert.equal(saved.waiting.category, "goal-time-limit");
  assert.match(saved.progress, /30 分钟上限/);
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "failed");
  assert.equal(captures, 0);
  assert.equal(modelCalls, 0, "the hard deadline is enforced by lifecycle without asking the LLM to waive it");
  assert.equal(statusCalls, 1, "the already scheduled native action receipt is still recorded after the deadline");
  const savedOperation = records.get(`operations:o:${operationId}`).value;
  assert.equal(savedOperation.result.state, "accepted");
  assert.equal(savedOperation.status, "unknown", "accepted navigation is not proof that the screen arrived before the hard stop");
});

test("non-retryable model authorization errors stop automatic retries and preserve a manual retry path", () => {
  const records = new Map();
  const calls = [];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    calls.push(method);
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return mockBatchResult(params);
    }
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" }); return { revision: "1" }; }
    if (method === "data.get") return params.key === "provider" ? { value: provider } : records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "synthetic-frame" };
    if (method === "network.request") return { status: 401, bodyText: "unauthorized" };
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "start" });
  for (let turn = 0; output?.actions?.length && turn < 5; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }
  assert.equal(output.state, "idle");
  output = globalThis.onHaminnEvent({ type: "goal.submit", intent: "完成合成任务" });
  for (let turn = 0; output?.actions?.length && turn < 20; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) });
  }
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(output.state, "waiting");
  assert.equal(output.userRequired, true);
  assert.equal(saved.waiting.category, "model-configuration");
  assert.match(saved.progress, /HTTP 401/);
  assert.equal(calls.includes("worker.wait"), false);
  assert.equal(calls.filter((method) => method === "network.request").length, 1);
});

test("all Worker model purposes can consume a response stored as a Haminn file", () => {
  const records = new Map();
  const responseFiles = new Map();
  const purposes = [];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  let advancedToReview = false;
  let responseSequence = 0;

  function completeModelResponse(params) {
    const request = JSON.parse(params.bodyText);
    const userPart = request.messages[1].content;
    const prompt = Array.isArray(userPart) ? userPart.map((part) => part.text || "").join("\n") : String(userPart || "");
    let purpose;
    let content;
    if (prompt.includes("在本 AL 开始任何屏幕动作前")) {
      purpose = "al-plan";
      content = { estimatedMinutes: 1, budgetMinutes: purposes.filter((value) => value === purpose).length ? 30 : 15, strategy: "先观察再继续" };
    } else if (prompt.includes("本 AL 已到预算检查点")) {
      purpose = "al-review";
      content = { choice: "new-action-loop", reason: "换一条更直接的路径", nextStrategy: "按当前现场重新观察" };
    } else if (prompt.includes("判断是否值得保存经验")) {
      purpose = "learning";
      content = { saveExperience: false, saveTool: false };
    } else {
      purpose = "action";
      content = { state: "done", evidence: "截图结果符合合成目标" };
    }
    purposes.push(purpose);
    const logicalFileId = `model-response-${++responseSequence}`;
    responseFiles.set(logicalFileId, JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
    return { status: 200, file: { logicalFileId } };
  }

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) {
        const key = `${item.collection}:${item.key}`;
        if (item.op === "delete") records.delete(key);
        else records.set(key, { value: item.value, revision: "1" });
      }
      return mockBatchResult(params);
    }
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "data.get") {
      if (params.collection === "screen-interaction" && params.key === "provider") return { value: provider };
      return records.get(`${params.collection}:${params.key}`) || null;
    }
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", width: 1, height: 1, dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") return completeModelResponse(params);
    if (method === "files.readText") return { text: responseFiles.get(params.logicalFileId) };
    if (method === "files.delete") { responseFiles.delete(params.logicalFileId); return { deleted: true }; }
    if (method === "worker.wait") return { waitedMs: params.ms };
    throw new Error(`Unexpected tool: ${method}`);
  }

  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 200; turn += 1) {
      const call = output.actions[0];
      const result = tool(call.method, call.params);
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
      if (!advancedToReview && call.method === "data.batch") {
        const active = records.get("agent-runtime:active-goal")?.value;
        if (active?.actionLoop?.status === "running" && Number(active.actionLoop.budgetMinutes) === 15) {
          now += 15 * 60_000;
          advancedToReview = true;
        }
      }
    }
    return output;
  }

  try {
    assert.equal(deliver({ type: "start" }).state, "idle");
    Date.now = () => now;
    const result = deliver({ type: "goal.submit", intent: "通过合成页面完成操作并复盘 AL" });
    assert.equal(result.state, "done", JSON.stringify({ result, purposes }));
    assert.ok(purposes.includes("al-plan"));
    assert.ok(purposes.includes("al-review"));
    assert.ok(purposes.includes("action"));
    assert.ok(purposes.includes("learning"));
    const saved = records.get("agent-runtime:active-goal")?.value;
    assert.equal(saved.actionLoop.index, 2);
    assert.equal(saved.actionLoopHistory[0].index, 1);
    assert.equal(saved.actionLoopHistory[0].endReason, "timeout-new-loop");
    assert.equal(responseFiles.size, 0, "every stored provider response file should be deleted after reading");
  } finally {
    Date.now = originalNow;
  }
});

test("priority user cancel is handled before Worker startup and clears every queued OST", async () => {
  await import(`./worker.mjs?goal-control=${Date.now()}`);
  const records = new Map();
  records.set("agent-runtime:active-goal", { revision: "8", value: {
    goalId: "g-control", taskId: "t-control", intent: "完成合成目标", state: "active",
    revision: 4, step: 3, journalSequence: 0, trace: [], waiting: null,
  } });
  records.set("goals:g:g-control", { revision: "12", value: { goalId: "g-control", state: "active", revision: 4 } });
  records.set("tasks:t:t-control", { revision: "20", value: { taskId: "t-control", state: "running", revision: 4 } });
  for (let index = 0; index < 105; index += 1) {
    records.set(`inbox:q:${String(index).padStart(3, "0")}`, { revision: 1,
      value: { type: "goal.submit", intent: `synthetic ${index}`, state: "queued" } });
  }
  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, params.limit)
      .map(([key, entry]) => ({ key: key.slice(params.collection.length + 1), ...entry })) };
    if (method === "data.put" || method === "data.batch") {
      const operations = method === "data.put" ? [{ op: "put", ...params }] : params.operations;
      for (const operation of operations) {
        const key = `${operation.collection}:${operation.key}`;
        const current = records.get(key);
        if ((operation.expectedRevision === "absent" && current) ||
            (operation.expectedRevision !== undefined && operation.expectedRevision !== "absent" &&
              current?.revision !== operation.expectedRevision)) throw new Error(`revision conflict: ${key}`);
      }
      return persistMockBatch(records, { operations });
    }
    throw new Error(`Unexpected tool: ${method}`);
  }
  function deliver(event) {
    let output = globalThis.onHaminnEvent(event);
    for (let turn = 0; output?.actions?.length && turn < 30; turn += 1) {
      const call = output.actions[0];
      output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId,
        ok: true, result: tool(call.method, call.params) });
    }
    return output;
  }

  const event = { type: "goal.control", eventId: "cancel-before-start", command: "cancel" };
  let interrupted = globalThis.onHaminnEvent(event);
  for (let turn = 0; interrupted?.actions?.length && turn < 3; turn += 1) {
    const call = interrupted.actions[0];
    interrupted = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId,
      ok: true, result: tool(call.method, call.params) });
  }
  assert.equal(interrupted.actions[0].method, "data.batch", "the first queue page and its progress receipt should commit together");
  tool(interrupted.actions[0].method, interrupted.actions[0].params);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey(event.eventId)}`)?.value?.queuedCancelled, 100);
  assert.equal([...records.keys()].filter(key => key.startsWith("inbox:q:")).length, 5);
  await import(`./worker.mjs?goal-control-restart=${Date.now()}`);
  const cancelled = deliver(event);
  assert.equal(cancelled.controlApplied, true, JSON.stringify(cancelled));
  assert.equal(cancelled.queuedCancelled, 105);
  assert.equal(records.get("agent-runtime:active-goal").value.state, "cancelled");
  assert.equal([...records.keys()].filter(key => key.startsWith("inbox:q:")).length, 0);
  const duplicate = deliver(event);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.queuedCancelled, 105);
  assert.equal(deliver({ type: "start" }).state, "cancelled");
});

test("a user pause CAS conflict reloads the current OST and applies the command without losing progress", async () => {
  await import(`./worker.mjs?goal-control-cas=${Date.now()}`);
  const records = new Map();
  const active = { goalId: "g-control-cas", taskId: "t-control-cas", runId: "run-control-cas",
    intent: "执行合成 OST", state: "active", taskType: "one-shot", taskKind: "OST", revision: 4,
    step: 3, journalSequence: 0, trace: [], waiting: null, progress: "旧进度" };
  records.set("agent-runtime:active-goal", { value: active, revision: "active-r1" });
  records.set("goals:g:g-control-cas", { value: { goalId: active.goalId, state: "active", revision: 4 }, revision: "goal-r1" });
  records.set("tasks:t:t-control-cas", { value: { taskId: active.taskId, goalId: active.goalId,
    state: "running", revision: 4 }, revision: "task-r1" });
  let conflictOnce = true;

  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.batch") {
      const finalControl = params.operations.some(operation => operation.collection === "agent-runtime" &&
        operation.key === "active-goal") && params.operations.some(operation => operation.collection === "agent-runtime" &&
        operation.key.startsWith("event:"));
      if (finalControl && conflictOnce) {
        conflictOnce = false;
        records.set("agent-runtime:active-goal", { value: { ...active, revision: 5, step: 9,
          progress: "并发推进后的最新进度" }, revision: "active-r2" });
        return { __toolError: { code: "E_CONFLICT", message: "active-goal revision changed" } };
      }
      return persistMockBatch(records, params);
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "goal.control", eventId: "pause-control-cas", command: "pause" });
  for (let turn = 0; output?.actions?.length && turn < 40; turn += 1) {
    const call = output.actions[0];
    const result = tool(call.method, call.params);
    output = result?.__toolError
      ? globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: result.__toolError })
      : globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
  }
  const saved = records.get("agent-runtime:active-goal").value;
  assert.equal(output.controlApplied, true);
  assert.equal(saved.state, "paused");
  assert.equal(saved.step, 9, "recovery must apply pause to the latest durable OST instead of restoring its stale snapshot");
  assert.equal(saved.progress, "用户已暂停任务；继续时先重新观察屏幕并核对未完成操作。");
  assert.equal(records.get(`agent-runtime:${eventReceiptKey("pause-control-cas")}`).value.state, "completed");
});

test("a cancellation queue-page CAS conflict rescans entries without double-counting them", async () => {
  await import(`./worker.mjs?goal-control-queue-cas=${Date.now()}`);
  const records = new Map();
  const active = { goalId: "g-queue-cas", taskId: "t-queue-cas", runId: "run-queue-cas",
    intent: "取消合成任务", state: "active", taskType: "one-shot", taskKind: "OST", revision: 2,
    step: 1, journalSequence: 0, trace: [], waiting: null };
  records.set("agent-runtime:active-goal", { value: active, revision: "active-r1" });
  records.set("goals:g:g-queue-cas", { value: { goalId: active.goalId, state: "active", revision: 2 }, revision: "goal-r1" });
  records.set("tasks:t:t-queue-cas", { value: { taskId: active.taskId, goalId: active.goalId,
    state: "running", revision: 2 }, revision: "task-r1" });
  for (let index = 0; index < 2; index += 1) records.set(`inbox:q:queue-cas-${index}`, {
    value: { type: "goal.submit", intent: `待取消目标 ${index}` }, revision: `queue-r${index}` });
  let conflictOnce = true;

  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [...records.entries()]
      .filter(([key]) => key.startsWith(`${params.collection}:${params.prefix}`))
      .sort(([left], [right]) => left.localeCompare(right)).slice(0, params.limit)
      .map(([key, value]) => ({ key: key.slice(params.collection.length + 1), ...value })) };
    if (method === "data.batch") {
      const pageDelete = params.operations.some(operation => operation.collection === "inbox" && operation.op === "delete");
      if (pageDelete && conflictOnce) {
        conflictOnce = false;
        return { __toolError: { code: "E_CONFLICT", message: "queue page changed" } };
      }
      return persistMockBatch(records, params);
    }
    throw new Error(`Unexpected tool: ${method}`);
  }

  let output = globalThis.onHaminnEvent({ type: "goal.control", eventId: "cancel-control-queue-cas", command: "cancel" });
  for (let turn = 0; output?.actions?.length && turn < 60; turn += 1) {
    const call = output.actions[0];
    const result = tool(call.method, call.params);
    output = result?.__toolError
      ? globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: result.__toolError })
      : globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result });
  }
  assert.equal(output.controlApplied, true);
  assert.equal(output.queuedCancelled, 2);
  assert.equal(records.get(`agent-runtime:${eventReceiptKey("cancel-control-queue-cas")}`).value.queuedCancelled, 2);
  assert.equal([...records.keys()].filter(key => key.startsWith("inbox:q:")).length, 0);
  assert.equal(records.get("agent-runtime:active-goal").value.state, "cancelled");
});

test("Worker restart resumes dependency scheduling after a durable task-done decision", async () => {
  await import(`./worker.mjs?task-done-restart=${Date.now()}`);
  const now = Date.now();
  const first = { taskId: "task-restart-first", runId: "run-first", objective: "读取最新消息", kind: "screen-work",
    state: "done", dependencies: [], objectKey: null, revision: 2, createdAt: 10, planIndex: 0, progress: "已读取" };
  const second = { taskId: "task-restart-second", runId: "run-second", objective: "核对回复结果", kind: "screen-work",
    state: "ready", dependencies: [first.taskId], objectKey: null, revision: 1, createdAt: 10, planIndex: 1, progress: "" };
  const active = {
    goalId: "goal-task-done-restart", taskId: first.taskId, runId: first.runId,
    intent: "读取新消息并核对回复", state: "active", taskType: "one-shot", taskKind: "OST",
    step: 2, revision: 5, createdAt: now, goalAttemptStartedAt: now, goalDeadlineAt: now + 30 * 60_000, progress: "已读取",
    goalPlan: { scope: {}, triggers: [], completion: "LLM 判断", priority: 0, acceptedBoundary: "after-creation" },
    taskPlan: { dependencies: first.dependencies, objectKey: first.objectKey }, taskRecordKind: first.kind,
    taskObjective: first.objective, taskReviewMode: false,
    taskGraph: { coordinatorTaskId: "task-restart-coordinator", coordinatorRunId: "run-coordinator",
      coordinatorRevision: 2, currentTaskId: first.taskId, createdAt: 10, tasks: [first, second] },
    lastDecision: { state: "task-done", evidence: "已读取最新消息" }, trace: [],
  };
  const start = globalThis.onHaminnEvent({ type: "start" });
  assert.equal(start.actions[0].method, "data.get");
  const resumed = globalThis.onHaminnEvent({ type: "tool.result", callId: start.actions[0].callId, ok: true,
    result: { value: active, revision: "1" } });
  assert.equal(resumed.actions[0].method, "data.get");
  assert.equal(resumed.actions[0].params.key, `t:${second.taskId}`);
  const handedOff = globalThis.onHaminnEvent({ type: "tool.result", callId: resumed.actions[0].callId, ok: true,
    result: { value: second, revision: "task-next-r4" } });
  assert.equal(handedOff.actions[0].method, "data.batch");
  const operations = handedOff.actions[0].params.operations;
  const nextTask = operations.find(item => item.collection === "tasks" && item.key === `t:${second.taskId}`)?.value;
  const savedActive = operations.find(item => item.collection === "agent-runtime" && item.key === "active-goal")?.value;
  assert.equal(nextTask?.state, "running", JSON.stringify(operations));
  assert.equal(operations.find(item => item.collection === "tasks" && item.key === `t:${second.taskId}`)?.expectedRevision, "task-next-r4");
  assert.equal(savedActive.taskId, second.taskId);
  assert.equal(savedActive.lastDecision, null);
});

test("goal cancellation updates all unfinished decomposed Tasks in the same HO transaction", async () => {
  await import(`./worker.mjs?task-graph-cancel=${Date.now()}`);
  const records = new Map();
  const now = Date.now();
  const active = {
    goalId: "goal-graph-cancel", taskId: "task-graph-current", runId: "run-current",
    intent: "处理合成会话并核对回复", state: "active", taskType: "one-shot", taskKind: "OST",
    step: 2, revision: 4, createdAt: now, progress: "执行第一项",
    taskGraph: { coordinatorTaskId: "task-graph-coordinator", coordinatorRunId: "run-coordinator",
      coordinatorRevision: 2, currentTaskId: "task-graph-current", createdAt: now, tasks: [
        { schemaVersion: 1, taskId: "task-graph-current", goalId: "goal-graph-cancel", runId: "run-current",
          revision: 1, kind: "screen-work", objective: "处理第一项", state: "running", dependencies: [],
          objectKey: null, progress: "", waiting: null, resultRefs: [], createdAt: now, updatedAt: now, planIndex: 0 },
        { schemaVersion: 1, taskId: "task-graph-next", goalId: "goal-graph-cancel", runId: "run-next",
          revision: 1, kind: "screen-work", objective: "处理第二项", state: "ready", dependencies: ["task-graph-current"],
          objectKey: null, progress: "", waiting: null, resultRefs: [], createdAt: now, updatedAt: now, planIndex: 1 },
      ] },
    trace: [],
  };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  records.set("goals:g:goal-graph-cancel", { value: { goalId: active.goalId, state: "active", revision: 4 }, revision: "8" });
  records.set("tasks:t:task-graph-current", { value: { ...active.taskGraph.tasks[0] }, revision: "2" });
  records.set("tasks:t:task-graph-next", { value: { ...active.taskGraph.tasks[1] }, revision: "2" });
  records.set("tasks:t:task-graph-coordinator", { value: {
    schemaVersion: 1, taskId: "task-graph-coordinator", goalId: active.goalId, runId: "run-coordinator",
    revision: 2, kind: "coordination", objective: active.intent, state: "waiting",
    dependencies: ["task-graph-current", "task-graph-next"], objectKey: null,
    progress: "等待子任务完成", waiting: null, resultRefs: [], createdAt: now, updatedAt: now,
  }, revision: 2 });
  function tool(method, params) {
    if (method === "data.get") return records.get(`${params.collection}:${params.key}`) || null;
    if (method === "data.scan") return { items: [] };
    if (method === "data.batch") return persistMockBatch(records, params);
    throw new Error(`Unexpected tool: ${method}`);
  }
  let output = globalThis.onHaminnEvent({ type: "goal.control", eventId: "cancel-graph", command: "cancel" });
  for (let turn = 0; output?.actions?.length && turn < 16; turn += 1) {
    const call = output.actions[0];
    output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true,
      result: tool(call.method, call.params) });
  }
  assert.equal(output.controlApplied, true);
  assert.equal(records.get("agent-runtime:active-goal").value.taskGraph.tasks[0].state, "cancelled");
  assert.equal(records.get("agent-runtime:active-goal").value.taskGraph.tasks[1].state, "cancelled");
  assert.equal(records.get("tasks:t:task-graph-current").value.state, "cancelled");
  assert.equal(records.get("tasks:t:task-graph-next").value.state, "cancelled");
  assert.equal(records.get("tasks:t:task-graph-coordinator").value.state, "cancelled");
});
