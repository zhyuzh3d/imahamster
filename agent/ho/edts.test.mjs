import test from "node:test";
import assert from "node:assert/strict";
import { createEventTask, notificationInboxKey, normalizeEventTaskPlan, parseEventMatchDecision, sanitizeNotificationEvent, transitionEventTask } from "./edts.mjs";

test("event task plans keep exact package filters and reject unsupported or broad filters", () => {
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "one-shot" }), null);
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "notification", sourcePackages: ["com.tencent.mm", "com.tencent.mm"], description: "收到新消息时触发",
  } }), { kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到新消息时触发" });
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "notification", sourcePackages: ["*"], description: "全部通知",
  } }), /包名/);
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "timer", sourcePackages: [], description: "每小时",
  } }), /受支持/);
});

test("event task records are durable lifecycle state, separate from each triggered OST", () => {
  const eventTask = createEventTask({ eventTaskId: "edt-1", goalId: "g-1", taskId: "t-1",
    intent: "收到新消息时根据上下文回复", trigger: { kind: "notification", sourcePackages: ["com.tencent.mm"], description: "有新消息" }, at: 500 });
  assert.equal(eventTask.state, "registering");
  assert.equal(eventTask.createdAt, 500);
  assert.equal(eventTask.missedNotifications, 0);
  assert.equal(eventTask.intent, "收到新消息时根据上下文回复");
});

test("EDT pause, resume, cancel are explicit transitions and a saved in-flight control can be retried", () => {
  const active = createEventTask({ eventTaskId: "edt-2", goalId: "g-2", taskId: "t-2",
    intent: "等待通知", trigger: { kind: "notification", sourcePackages: ["com.example.chat"], description: "新通知" } });
  const pause = transitionEventTask({ ...active, state: "active" }, "pause", 10);
  assert.equal(pause.eventTask.state, "pausing");
  assert.equal(transitionEventTask(pause.eventTask, "pause", 11).changed, true);
  const paused = transitionEventTask({ ...pause.eventTask, state: "active" }, "pause", 12).eventTask;
  const resume = transitionEventTask({ ...paused, state: "paused" }, "resume", 13);
  assert.equal(resume.eventTask.state, "registering");
  assert.equal(transitionEventTask({ ...resume.eventTask, state: "active" }, "cancel", 14).eventTask.state, "cancelling");
});

test("notification intake is bounded, idempotency uses the source event ID, and LLM decisions are explicit", () => {
  const event = sanitizeNotificationEvent({ type: "notification.posted", eventId: "notification:42",
    subscriptionId: "edt-1", sourcePackage: "com.tencent.mm", occurredAt: 900,
    notification: { title: "消息", text: "测试内容".repeat(3000), category: "msg" } });
  assert.equal(event.notification.text.length, 4096);
  assert.equal(notificationInboxKey(event.eventId), notificationInboxKey(event.eventId));
  assert.deepEqual(parseEventMatchDecision({ decision: "trigger", reason: "匹配新消息", ostIntent: "读取上下文并回复" }), {
    decision: "trigger", reason: "匹配新消息", ostIntent: "读取上下文并回复",
  });
  assert.equal(parseEventMatchDecision({ decision: "ignore", reason: "不符合触发条件" }).decision, "ignore");
  assert.throws(() => parseEventMatchDecision({ decision: "trigger", reason: "没有 OST" }), /OST/);
});
