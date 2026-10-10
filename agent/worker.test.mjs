import test from "node:test";
import assert from "node:assert/strict";
import "./worker.mjs";

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
      modelTurn += 1;
      const decision = modelTurn === 1
        ? { state: "wait", confidence: 0.95, evidence: "当前画面没有可处理的新事项", waitMs: 1000 }
        : { state: "done", confidence: 0.98, evidence: "目标已完成，画面显示完成状态" };
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
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
    if (method === "network.request") {
      const decision = decisions[modelTurn++];
      return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
    }
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
  assert.equal(records.get("agent-runtime:active-goal").value.state, "done");
});

test("an uncertain screen effect blocks another action and stays recoverable", () => {
  const records = new Map();
  let modelTurn = 0;
  let taps = 0;
  const decisions = [
    { state: "action", confidence: 0.98, evidence: "合成页面显示按钮", action: { type: "tap", target: "合成按钮", label: "Continue", x: 0.5, y: 0.5 } },
    { state: "action", confidence: 0.98, operationResult: "unknown", evidence: "截图无法判断上一次点击是否生效", action: { type: "tap", target: "另一个按钮", label: "Retry", x: 0.7, y: 0.5 } },
  ];
  const provider = { baseUrl: "https://model.example", apiKey: "x".repeat(24), model: "vision-model" };

  function tool(method, params) {
    if (method === "data.batch") {
      for (const item of params.operations) records.set(`${item.collection}:${item.key}`, { value: item.value, revision: "1" });
      return { results: [] };
    }
    if (method === "data.get") return { value: params.key === "provider" ? provider : records.get(`${params.collection}:${params.key}`)?.value };
    if (method === "data.scan") return { items: [] };
    if (method === "interaction.capture") return { mime: "image/jpeg", dataBase64: "c3ludGhldGljLWZyYW1l" };
    if (method === "network.request") return { status: 200, bodyText: JSON.stringify({ choices: [{ message: { content: JSON.stringify(decisions[modelTurn++]) } }] }) };
    if (method === "interaction.tap") { taps += 1; return { accepted: true }; }
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
  assert.equal(result.state, "failed");
  assert.equal(taps, 1);
  assert.equal(operation.status, "unknown");
  assert.equal(active.pendingOperationId, operation.operationId);
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
