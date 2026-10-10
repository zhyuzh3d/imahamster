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
