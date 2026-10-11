import test from "node:test";
import assert from "node:assert/strict";
import { eventReceiptKey } from "./ho/events.mjs";
import { notificationInboxKey, timerInboxKey } from "./ho/edts.mjs";
import { memorySourceRef } from "./me/memory.mjs";
import "./worker.mjs";

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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
    { state: "action", confidence: 0.98, evidence: "合成页面显示唯一按钮", action: { type: "tap", target: "合成测试按钮", label: "Continue", x: 0.5, y: 0.5 } },
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
      return { results: [] };
    }
    if (method === "data.put") return { revision: "1" };
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
    }
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
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
  let taps = 0;
  let modelCalls = 0;

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return { results: [] };
    }
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
    if (method === "data.scan") return { items: [] };
    if (method === "data.put") {
      records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" });
      return { revision: "1" };
    }
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") {
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
  assert.equal(active.trace.find((event) => event.phase === "decision" && event.decision === "done")?.evidence,
    "根据最终画面和操作历史，我判断合成目标已完成");
  assert.equal(Object.hasOwn(active.trace.find((event) => event.phase === "decision" && event.decision === "done"), "confidence"), false);
  assert.equal(active.trace.filter((event) => event.phase === "model.error").length, 2);
  assert.ok(active.trace.some((event) => event.phase === "recovery.scheduled" && event.mode === "yield-and-reobserve"));
  assert.ok(active.trace.some((event) => event.phase === "recovery.scheduled" && event.mode === "backoff"));
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
      return { results: [] };
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
    if (method === "data.get") { calls.push(`get:${params.key}`); return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value }; }
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" }); return { revision: "2" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
      return { results: [] };
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
  for (let turn = 0; output?.actions?.length && turn < 12; turn += 1) {
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
      return { results: [] };
    }
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "1" }); return { revision: "1" }; }
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
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
      return { results: [] };
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
