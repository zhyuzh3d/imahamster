import { assertEventId, eventReceiptKey } from "./events.mjs";

export function normalizeEventTaskPlan(plan) {
  if (!plan || plan.taskType === undefined || plan.taskType === "one-shot") return null;
  if (plan.taskType !== "event-driven") throw new TypeError("任务类型必须是 one-shot 或 event-driven");
  const trigger = plan.trigger;
  if (trigger?.kind === "timer") {
    const schedule = normalizeTimerSchedule(trigger.schedule);
    const description = String(trigger.description || "").trim();
    if (!description || description.length > 1000) throw new TypeError("事件任务缺少有效的计时触发说明");
    return { kind: "timer", schedule, description };
  }
  if (trigger?.kind !== "notification") {
    throw new TypeError("当前事件任务需要一个受支持的通知或计时触发条件");
  }
  const sourcePackages = Array.isArray(trigger.sourcePackages)
    ? [...new Set(trigger.sourcePackages.map(value => String(value || "").trim()))]
    : [];
  if (sourcePackages.length < 1 || sourcePackages.length > 16 || sourcePackages.some(value =>
    value.length > 255 || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(value))) {
    throw new TypeError("事件任务必须列出 1 到 16 个有效的通知来源应用包名");
  }
  const description = String(trigger.description || "").trim();
  if (!description || description.length > 1000) throw new TypeError("事件任务缺少有效的触发说明");
  return { kind: "notification", sourcePackages, description };
}

function normalizeTimerSchedule(schedule) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new TypeError("计时事件任务缺少 schedule 对象");
  }
  if (schedule.kind === "once") {
    const at = Number(schedule.at);
    if (!Number.isSafeInteger(at) || at <= 0) throw new TypeError("一次性计时必须提供 epoch 毫秒 at");
    return { kind: "once", at };
  }
  if (schedule.kind === "interval") {
    const intervalMs = Number(schedule.intervalMs);
    const firstAt = schedule.firstAt === undefined ? undefined : Number(schedule.firstAt);
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 365 * 24 * 60 * 60_000 ||
        (firstAt !== undefined && (!Number.isSafeInteger(firstAt) || firstAt <= 0))) {
      throw new TypeError("固定间隔计时参数无效");
    }
    return { kind: "interval", intervalMs, ...(firstAt === undefined ? {} : { firstAt }) };
  }
  if (schedule.kind === "calendar") {
    const daysOfWeek = Array.isArray(schedule.daysOfWeek)
      ? [...new Set(schedule.daysOfWeek.map(Number))].sort((a, b) => a - b) : [];
    const hour = Number(schedule.hour);
    const minute = Number(schedule.minute);
    const firstAt = schedule.firstAt === undefined ? undefined : Number(schedule.firstAt);
    if (!daysOfWeek.length || daysOfWeek.length !== schedule.daysOfWeek.length || daysOfWeek.some(day =>
      !Number.isInteger(day) || day < 1 || day > 7) || !Number.isInteger(hour) || hour < 0 || hour > 23 ||
        !Number.isInteger(minute) || minute < 0 || minute > 59 ||
        (firstAt !== undefined && (!Number.isSafeInteger(firstAt) || firstAt <= 0))) {
      throw new TypeError("本地日历计时参数无效");
    }
    return { kind: "calendar", daysOfWeek, hour, minute, ...(firstAt === undefined ? {} : { firstAt }) };
  }
  throw new TypeError("不支持的计时触发类型");
}

export function createEventTask({ eventTaskId, goalId, taskId, runId, intent, trigger, at = Date.now() }) {
  if (![eventTaskId, goalId, taskId].every(value => typeof value === "string" && value.length > 0)) {
    throw new TypeError("事件任务身份不完整");
  }
  const normalized = normalizeEventTaskPlan({ taskType: "event-driven", trigger });
  if (!normalized) throw new TypeError("事件任务触发器无效");
  if (typeof intent !== "string" || !intent.trim() || intent.length > 16_000) {
    throw new TypeError("事件任务意图无效");
  }
  return {
    schemaVersion: 1,
    eventTaskId,
    goalId,
    taskId,
    runId: typeof runId === "string" && runId ? runId : `edt-${eventTaskId}`,
    intent: intent.trim(),
    trigger: normalized,
    state: "registering",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    lastEventAt: null,
    lastEventState: null,
    missedNotifications: 0,
    journalSequence: 0,
    clarifications: [],
  };
}

export function transitionEventTask(eventTask, command, at = Date.now()) {
  if (!eventTask?.eventTaskId) throw new TypeError("事件任务记录无效");
  const transitional = { pause: "pausing", resume: "registering", cancel: "cancelling" };
  if (eventTask.state === transitional[command] && eventTask.lastControl === command) {
    return { changed: true, eventTask };
  }
  const allowed = {
    pause: new Set(["active", "registering", "needs-user", "needs-app-authorization", "needs-system-access"]),
    resume: new Set(["paused", "needs-user", "needs-app-authorization", "needs-system-access"]),
    cancel: new Set(["active", "registering", "paused", "needs-user", "needs-app-authorization", "needs-system-access", "pausing", "cancelling"]),
  };
  if (!allowed[command] || !allowed[command].has(eventTask.state)) {
    return { changed: false, eventTask };
  }
  const state = command === "pause" ? "pausing" : command === "resume" ? "registering" : "cancelling";
  return { changed: true, eventTask: {
    ...eventTask, state, revision: Number(eventTask.revision || 0) + 1,
    updatedAt: at, lastControl: command,
  } };
}

export function sanitizeNotificationEvent(event) {
  if (!event || event.type !== "notification.posted") throw new TypeError("通知事件类型无效");
  const eventId = assertEventId(event.eventId);
  const subscriptionId = String(event.subscriptionId || "");
  const sourcePackage = String(event.sourcePackage || "");
  const occurredAt = Number(event.occurredAt);
  if (!subscriptionId || subscriptionId.length > 128 || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(sourcePackage) ||
      !Number.isFinite(occurredAt) || occurredAt <= 0) throw new TypeError("通知事件元信息无效");
  return {
    type: "notification.posted",
    eventId,
    subscriptionId,
    sourcePackage,
    occurredAt,
    notification: {
      title: String(event.notification?.title || "").slice(0, 256),
      text: String(event.notification?.text || "").slice(0, 4096),
      category: String(event.notification?.category || "").slice(0, 80),
    },
  };
}

export function notificationInboxKey(eventId) {
  return `n:${eventReceiptKey(assertEventId(eventId)).slice("event:".length)}`;
}

export function timerInboxKey(eventId) {
  return `t:${eventReceiptKey(assertEventId(eventId)).slice("event:".length)}`;
}

export function sanitizeTimerEvent(event) {
  if (!event || event.type !== "timer.fired") throw new TypeError("计时事件类型无效");
  const eventId = assertEventId(event.eventId);
  const timerId = String(event.timerId || "");
  const scheduledAt = Number(event.scheduledAt);
  const occurredAt = Number(event.occurredAt);
  const missedCount = Number(event.missedCount || 0);
  const scheduleRevision = Number(event.scheduleRevision);
  if (!timerId || timerId.length > 128 || !Number.isSafeInteger(scheduledAt) || scheduledAt <= 0 ||
      !Number.isSafeInteger(occurredAt) || occurredAt <= 0 || !Number.isSafeInteger(missedCount) || missedCount < 0 ||
      !Number.isSafeInteger(scheduleRevision) || scheduleRevision < 1) throw new TypeError("计时事件元信息无效");
  const identity = event.sourceIdentity && typeof event.sourceIdentity === "object" ? event.sourceIdentity : {};
  return {
    type: "timer.fired", eventId, timerId, scheduledAt, occurredAt,
    missedCount: Math.min(missedCount, 1_000_000), scheduleRevision,
    sourceIdentity: {
      releaseId: identity.releaseId == null ? null : String(identity.releaseId).slice(0, 128),
      devRevision: identity.devRevision != null && Number.isSafeInteger(Number(identity.devRevision)) ? Number(identity.devRevision) : null,
      trustRevision: identity.trustRevision != null && Number.isSafeInteger(Number(identity.trustRevision)) ? Number(identity.trustRevision) : null,
    },
  };
}

export function parseEventMatchDecision(value) {
  if (!value || !["trigger", "ignore", "ask"].includes(value.decision)) {
    throw new TypeError("通知匹配结果必须是 trigger、ignore 或 ask");
  }
  const reason = String(value.reason || "").trim();
  if (!reason || reason.length > 1000) throw new TypeError("通知匹配缺少判断依据");
  if (value.decision === "trigger") {
    const ostIntent = String(value.ostIntent || "").trim();
    if (!ostIntent || ostIntent.length > 16_000) throw new TypeError("通知触发的 OST 意图无效");
    return { decision: "trigger", reason, ostIntent };
  }
  return { decision: value.decision, reason, ...(value.question ? { question: String(value.question).slice(0, 1000) } : {}) };
}
