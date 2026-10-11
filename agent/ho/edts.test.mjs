import test from "node:test";
import assert from "node:assert/strict";
import { createEventTask, notificationInboxKey, normalizeEventTaskPlan, parseEventMatchDecision, sanitizeNotificationEvent, sanitizeTimerEvent, timerInboxKey, transitionEventTask } from "./edts.mjs";

test("event task plans keep exact package filters and reject unsupported or broad filters", () => {
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "one-shot" }), null);
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "notification", sourcePackages: ["com.tencent.mm", "com.tencent.mm"], description: "收到新消息时触发",
  } }), { kind: "notification", sourcePackages: ["com.tencent.mm"], description: "收到新消息时触发" });
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "notification", sourcePackages: ["*"], description: "全部通知",
  } }), /包名/);
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "unsupported", sourcePackages: [], description: "每小时",
  } }), /受支持/);
});

test("timer EDT plans validate one-shot, interval, and device-local calendar schedules", () => {
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "timer", description: "每天上午九点执行", schedule: { kind: "calendar", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], hour: 9, minute: 0 },
  } }), { kind: "timer", description: "每天上午九点执行",
    schedule: { kind: "calendar", daysOfWeek: [1, 2, 3, 4, 5, 6, 7], hour: 9, minute: 0 } });
  assert.deepEqual(normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "timer", description: "每小时检查", schedule: { kind: "interval", intervalMs: 3_600_000, firstAt: 1_800_000_000_000 },
  } }).schedule, { kind: "interval", intervalMs: 3_600_000, firstAt: 1_800_000_000_000 });
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "timer", description: "重复", schedule: { kind: "interval", intervalMs: 5_000 },
  } }), /固定间隔计时参数无效/);
  assert.throws(() => normalizeEventTaskPlan({ taskType: "event-driven", trigger: {
    kind: "timer", description: "每天", schedule: { kind: "calendar", daysOfWeek: [1, 1], hour: 9, minute: 0 },
  } }), /本地日历计时参数无效/);
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

test("timer events are normalized and use a separate durable inbox key", () => {
  const event = sanitizeTimerEvent({ type: "timer.fired", eventId: "worker-timer:edt-1:1:1800000000000",
    timerId: "edt-1", scheduledAt: 1_800_000_000_000, occurredAt: 1_800_000_060_000,
    missedCount: 2, scheduleRevision: 1,
    sourceIdentity: { releaseId: "release-1", devRevision: null, trustRevision: 2 } });
  assert.equal(event.missedCount, 2);
  assert.equal(event.sourceIdentity.devRevision, null);
  assert.match(timerInboxKey(event.eventId), /^t:[0-9a-f]{16}$/);
  assert.notEqual(timerInboxKey(event.eventId), notificationInboxKey(event.eventId));
  assert.throws(() => sanitizeTimerEvent({ ...event, occurredAt: 0 }), /计时事件元信息无效/);
});
