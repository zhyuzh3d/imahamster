import test from "node:test";
import assert from "node:assert/strict";
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
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

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
    for (let turn = 0; output?.actions?.length && turn < 32; turn += 1) {
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

  const waiting = deliver({ type: "goal.submit", intent: "持续检查新消息并根据上下文处理" });
  assert.equal(waiting.state, "waiting");
  assert.equal(modelTurn, 1);
  assert.equal(captures, 1);
  const active = records.get("agent-runtime:active-goal").value;
  assert.equal(active.state, "waiting");
  assert.equal(records.get(`goals:g:${active.goalId}`).value.state, "active");
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "waiting");
  assert.equal(deliver({ type: "goal.submit", intent: "收集订阅号更新并整理摘要" }).state, "queued");

  const complete = deliver({ type: "tick" });
  assert.equal(complete.state, "done");
  assert.equal(modelTurn, 3);
  assert.equal(captures, 3);
  assert.equal(records.get(`goals:g:${active.goalId}`).value.state, "done");
  assert.equal(records.get(`tasks:t:${active.taskId}`).value.state, "done");
  const secondGoal = [...records.entries()].find(([key, record]) => key.startsWith("goals:g:") && record.value.intent.includes("订阅号"))[1].value;
  assert.equal(secondGoal.state, "done");
  assert.equal([...records.entries()].filter(([key]) => key.startsWith("tasks:t:") && records.get(key).value.state === "done").length, 2);
});

test("screen effects persist a prepared receipt and require visual verification before completion", () => {
  const records = new Map();
  const callOrder = [];
  let modelTurn = 0;
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
      try { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: true, result: tool(call.method, call.params) }); }
      catch (error) { output = globalThis.onHaminnEvent({ type: "tool.result", callId: call.callId, ok: false, error: { message: error.message } }); }
    }
    return output;
  }

  const result = deliver({ type: "goal.submit", intent: "点击合成测试按钮并确认完成" });
  assert.equal(result.state, "done", JSON.stringify({ result, records: [...records.entries()] }));
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
  let prompt = "";
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
      if (!text.includes("在本 AL 开始任何屏幕动作前") && !text.includes("判断是否值得保存经验")) prompt = text;
      return modelCall(params, () => ({ state: "wait", operationResult: "unknown", evidence: "截图无法确认合成消息是否已经发送", waitMs: 1000 }));
    }
    if (method === "worker.wait") return { waitedMs: params.ms };
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
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

  const result = deliver({ type: "start" });
  assert.equal(result.state, "waiting");
  assert.match(prompt, /"status":"returned"/);
  assert.match(prompt, /Synthetic contact/);
  assert.ok(prompt.includes(intendedContent), "recovery context must preserve the full allowed draft length");
  assert.match(prompt, /Bridge accepted 不等于界面效果已发生/);
  assert.equal(taps, 0);
  assert.equal(records.get("operations:o:operation-recovery").value.status, "unknown");
  assert.equal(records.get("agent-runtime:active-goal").value.pendingOperationId, "operation-recovery");
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
    intent: "完成合成任务", state: "paused", step: 2, revision: 3, progress: "已保存进度", waiting: { reason: "用户已暂停" } };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };
  let captures = 0;

  function tool(method, params) {
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
    if (method === "data.put") { records.set(`${params.collection}:${params.key}`, { value: params.value, revision: "2" }); return { revision: "2" }; }
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return { results: [] };
    }
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") { captures += 1; return { mime: "image/jpeg", dataBase64: "synthetic-frame" }; }
    if (method === "network.request") return modelCall(params, () => ({ state: "done", evidence: "截图确认合成任务已完成" }));
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

test("LLM can start a new action loop after timeout and choose a reusable experience after success", () => {
  const records = new Map();
  const active = { goalId: "goal-new-action-loop", taskId: "task-new-action-loop", runId: "run-new-action-loop",
    intent: "完成合成任务", state: "running", step: 7, revision: 9, progress: "当前路径耗时较长",
    actionLoop: { index: 2, status: "running", budgetMinutes: 15, estimatedMinutes: 15, elapsedMs: 15 * 60_000, segmentStartedAt: null }, trace: [] };
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
  assert.deepEqual(records.get(`knowledge:tool-candidate:${active.goalId}`).value.toolRefs, ["interaction.tap"]);
});

test("the 30-minute single-goal deadline is a hard orchestration stop and is reported as retryable failure", () => {
  const records = new Map();
  const active = { goalId: "goal-deadline", taskId: "task-deadline", runId: "run-deadline",
    intent: "完成一个合成操作", state: "running", step: 4, revision: 5, progress: "等待本轮结果",
    createdAt: Date.now() - 31 * 60_000, goalAttemptStartedAt: Date.now() - 31 * 60_000,
    goalDeadlineAt: Date.now() - 60_000, actionLoop: { index: 1, status: "running", budgetMinutes: 15, elapsedMs: 2 * 60_000 } };
  records.set("agent-runtime:active-goal", { value: active, revision: "1" });
  let captures = 0;
  let modelCalls = 0;

  function tool(method, params) {
    if (method === "data.get") return params.key === "provider" ? { value: { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" } } : records.get(`${params.collection}:${params.key}`);
    if (method === "data.scan") return { items: [] };
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "2" });
      return { results: [] };
    }
    if (method === "interaction.capture") { captures += 1; return { dataBase64: "synthetic" }; }
    if (method === "network.request") { modelCalls += 1; return modelCall(params, () => ({ state: "done", evidence: "done" })); }
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
