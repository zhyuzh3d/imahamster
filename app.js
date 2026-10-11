(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const message = $("#message");
  const consent = $("#consent");
  const setupButton = $("#setup-action");
  const workerPanel = $("#worker-panel");
  const workerStateLine = $("#worker-state");
  const workerProgressLine = $("#worker-progress");
  const workerEventTasks = $("#worker-event-tasks");
  const workerTraceLine = $("#worker-trace");
  const workerJournalDetails = $("#worker-journal-details");
  const workerJournalEvents = $("#worker-journal-events");
  const workerReplyInput = $("#worker-reply");
  const workerPauseButton = $("#worker-pause");
  const workerResumeButton = $("#worker-resume");
  const workerCancelButton = $("#worker-cancel");
  const memoryDetails = $("#memory-details");
  const memoryNotice = $("#memory-notice");
  const memoryList = $("#memory-list");
  const memoryRefreshButton = $("#memory-refresh");
  const memoryLoadMoreButton = $("#memory-load-more");
  const API_UA = "Mozilla/5.0 (Linux; Android 15; CMA-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";
  const BASE_BUBBLE_COLOR = "#4c7dff";
  const MAX_TASK_STEPS = 4096;
  const SUBMISSION_TIMEOUT_MS = 30 * 60_000;
  const SUBMISSION_TIMEOUT_MESSAGE = "前台提交准备超过 30 分钟；目标尚未交给后台 Worker。";
  const MAX_WAIT_RETRIES = 8;
  const SETTLE_MS = 2100;
  const SCREENSHOT_TIMEOUT_MS = 40_000;
  const VISION_REQUEST_TIMEOUT_MS = 35_000;
  const MODEL_BRIDGE_DEADLINE_MS = 55_000;
  const PROVIDER_PROBE_TIMEOUT_MS = 35_000;
  const MAX_TRACE_EVENTS = 96;

  let ready = false;
  let status = null;
  let provider = null;
  let networkGrant = "unknown";
  let operationRunning = false;
  let backgroundHandedOff = false;
  let modelConnectionVerified = false;
  let modelTestFailed = false;
  let lastResult = null;
  let activeTrace = null;
  let workerJournalGoalId = "";
  let workerJournalLoading = false;
  let submissionDeadlineAt = 0;
  let workerControlBusy = false;
  let hoControlModule = null;
  let memoryRecords = [];
  let memoryNextAfterKey = null;
  let memoryLoading = false;
  let memoryLoaded = false;
  let memoryEditingKey = "";
  let memoryDeleteConfirmKey = "";



  function setMessage(text, tone = "") {
    message.textContent = text;
    message.dataset.tone = tone;
  }

  function setStatus(key, text, state) {
    const value = $(`#${key}-status`);
    const dot = $(`#dot-${key}`);
    if (value) value.textContent = text;
    if (dot) dot.className = `status-dot ${state}`;
  }

  async function beginTrace(kind, instruction = "") {
    activeTrace = {
      runId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      startedAt: Date.now(),
      instructionLength: instruction.length,
      events: [],
    };
    await recordTrace({ phase: "started" });
  }

  async function recordTrace(event) {
    if (!activeTrace) return;
    activeTrace.events.push({ at: Date.now(), ...event });
    if (activeTrace.events.length > MAX_TRACE_EVENTS) {
      activeTrace.events.splice(0, activeTrace.events.length - MAX_TRACE_EVENTS);
    }
    // Keep only control-flow metadata: never persist screenshots, prompt text,
    // model evidence, message drafts, or input text.
    await withTimeout(haminn.data.put({ collection: "screen-interaction", key: "run-trace", value: activeTrace }),
      1500, "轨迹写入超时", "TRACE_WRITE_TIMEOUT").catch(() => {});
  }

  async function eventFingerprint(value) {
    const source = JSON.stringify(value);
    if (globalThis.crypto?.subtle && globalThis.TextEncoder) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
      return [...new Uint8Array(digest)].slice(0, 16).map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    let left = 0x811c9dc5;
    let right = 0x9e3779b9;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      left = Math.imul(left ^ code, 0x01000193);
      right = Math.imul(right ^ code ^ index, 0x85ebca6b);
    }
    return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
  }

  async function prepareDispatchEventId(type, identity) {
    const key = `pending-dispatch:${type}`;
    const fingerprint = await eventFingerprint(identity);
    const existing = await haminn.data.get({ collection: "agent-runtime", key });
    if (existing?.value?.fingerprint === fingerprint && Date.now() - existing.value.createdAt < 10 * 60_000) {
      return existing.value.eventId;
    }
    const random = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const eventId = `imhamster:${type}:${random}`;
    await haminn.data.put({ collection: "agent-runtime", key, value: { schemaVersion: 1, eventId, fingerprint, createdAt: Date.now() } });
    return eventId;
  }

  async function clearDispatchEventId(type, eventId) {
    const key = `pending-dispatch:${type}`;
    const existing = await haminn.data.get({ collection: "agent-runtime", key });
    if (existing?.value?.eventId !== eventId) return;
    await haminn.data.delete({ collection: "agent-runtime", key, expectedRevision: existing.revision }).catch(() => {});
  }

  function traceSummary(trace = activeTrace) {
    if (!trace || !Array.isArray(trace.events)) return "";
    const decisions = trace.events.filter((event) => event.phase === "decision");
    const rounds = [...new Set(trace.events.map((event) => event.step).filter(Number.isFinite))].sort((a, b) => a - b);
    if (!rounds.length) return "";
    const parts = rounds.map((step) => {
      const decision = decisions.find((event) => event.step === step);
      if (!decision) {
        const failure = trace.events.find((event) => event.step === step &&
          (event.code || /error|timeout|stopped/.test(event.phase)));
        const recovered = trace.events.some((event) => event.step === step &&
          ["observe-model-retry", "observe-capture-retry"].includes(event.phase));
        const status = failure?.phase === "observe-compare-error" ? "fallback"
          : recovered ? "retry" : failure?.phase === "model-timeout" ? "timeout" : "error";
        return `${step}:${status}${failure?.code ? `(${String(failure.code).slice(0, 32)})` : ""}`;
      }
      if (decision.state !== "action") return `${step}:${decision.state}`;
      const action = trace.events.filter((event) => event.phase === "bridge-action" && event.step === step).slice(-1)[0];
      const point = action?.actionType === "tap" ? `@${Number(action.x).toFixed(2)},${Number(action.y).toFixed(2)}`
        : action?.actionType === "input" ? `(${action.mode},${action.textLength})` : "";
      const target = String(action?.label || action?.target || "").replace(/\s+/g, " ").slice(0, 16);
      const result = action?.result === "accepted" ? "✓" : action?.result === "failed"
        ? `×${action.code ? `(${String(action.code).slice(0, 32)})` : ""}` : "…";
      return `${step}:${action?.actionType || decision.actionType || "action"}${point}${target ? `「${target}」` : ""}${result}`;
    });
    const observation = trace.events.filter((event) => event.phase === "observe-configured").slice(-1)[0];
    const observationSummary = observation
      ? ` · 区域监视 ${observation.regions?.length || 0} 区/${observation.combine || "any"}，变化 ${trace.events.filter(event => event.phase === "observe-changed").length} 次，未变 ${trace.events.filter(event => event.phase === "observe-unchanged").length + trace.events.filter(event => event.phase === "observe-review").length} 次`
      : "";
    return `${rounds.length}轮 · ${parts.join(" / ")}${observationSummary}`;
  }

  async function finishTrace(state, error = null) {
    if (!activeTrace) return;
    activeTrace.finishedAt = Date.now();
    activeTrace.status = state;
    if (error) activeTrace.error = /timeout/i.test(error.message || "") ? "timeout" : (error.code || "error");
    activeTrace.durationMs = activeTrace.finishedAt - activeTrace.startedAt;
    activeTrace.summary = traceSummary();
    await recordTrace({ phase: "finished", status: state, error: activeTrace.error || "" });
    const traceLine = $("#run-trace");
    if (traceLine) {
      traceLine.hidden = false;
      traceLine.textContent = `运行轨迹（${state}）：${activeTrace.summary}。`;
    }
  }

  function updateControls() {
    if (operationRunning) {
      setupButton.textContent = "正在处理…";
      setupButton.disabled = true;
      return;
    }
    if (!consent.checked) {
      setupButton.textContent = "勾选同意后继续";
      setupButton.disabled = true;
      return;
    }
    if (!status) {
      setupButton.textContent = "正在检查…";
      setupButton.disabled = true;
      return;
    }
    if (!status.supported) {
      setupButton.textContent = "设备版本不支持";
      setupButton.disabled = true;
      return;
    }
    if (status.authorization?.grant !== "allow") {
      setupButton.textContent = status.authorization?.grant === "deny" ? "重试 ImHamster 授权" : "授权 ImHamster";
      setupButton.disabled = false;
      return;
    }
    if (!status.accessibilityEnabled) {
      setupButton.textContent = "打开系统无障碍设置";
      setupButton.disabled = false;
      return;
    }
    if (!status.serviceConnected) {
      setupButton.textContent = "检查屏幕服务";
      setupButton.disabled = false;
      return;
    }
    if (!provider) {
      setupButton.textContent = "模型配置不可用";
      setupButton.disabled = true;
      return;
    }
    if (networkGrant !== "allow") {
      setupButton.textContent = "授权模型网络";
      setupButton.disabled = false;
      return;
    }
    if (!modelConnectionVerified) {
      setupButton.textContent = `测试 ${provider?.displayName || provider?.model || "模型"}`;
      setupButton.disabled = false;
      return;
    }
    if (!status.hasOverlay) {
      setupButton.textContent = "创建悬浮球";
      setupButton.disabled = false;
      return;
    }
    setupButton.textContent = "悬浮球已就绪";
    setupButton.disabled = true;
  }

  async function loadProviderConfig() {
    const saved = await haminn.data.get({ collection: "screen-interaction", key: "provider" });
    if (isValidProvider(saved?.value)) {
      provider = saved.value;
      return;
    }

    // Haminn's local happ CSP sets connect-src 'none', which intentionally
    // blocks fetch(), including same-origin fetches to files in the happ.
    // Load the private DEV config as a same-origin script instead.
    const config = configuredProviderCandidates()[0] || window.IMHAMSTER_PROVIDER_CONFIG;
    if (!isValidProvider(config)) throw new Error("本机模型配置字段不完整。");
    provider = {
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      apiKey: config.apiKey,
      model: config.model,
    };
    await haminn.data.put({ collection: "screen-interaction", key: "provider", value: provider });
    setMessage("模型配置已保存到本 ImHamster 实例。", "success");
  }

  function isValidProvider(value) {
    return Boolean(value && typeof value === "object" &&
      typeof value.baseUrl === "string" && /^https:\/\//i.test(value.baseUrl) &&
      typeof value.apiKey === "string" && value.apiKey.length >= 20 &&
      typeof value.model === "string" && value.model.length > 0 &&
      (value.endpointPath === undefined || (typeof value.endpointPath === "string" && /^\/[A-Za-z0-9._/-]+$/.test(value.endpointPath))));
  }

  function configuredProviderCandidates() {
    const candidates = Array.isArray(window.IMHAMSTER_PROVIDER_CANDIDATES)
      ? window.IMHAMSTER_PROVIDER_CANDIDATES : [window.IMHAMSTER_PROVIDER_CONFIG];
    return candidates.filter(isValidProvider);
  }

  function providerScope(candidate = provider) {
    return new URL(candidate.baseUrl).origin;
  }

  function providerEndpoint(candidate = provider) {
    return `${candidate.baseUrl.replace(/\/+$/, "")}${candidate.endpointPath || "/v1/chat/completions"}`;
  }

  function updateProviderLabel() {
    const label = $("#model-label");
    if (label) label.textContent = provider?.displayName || provider?.model || "当前模型";
  }

  async function refreshStatus({ preserveMessage = false } = {}) {
    if (!window.haminn?.isReady) return;
    try {
      status = await haminn.interaction.status();
      const grant = status.authorization?.grant;
      try {
        const networkAuthorization = await haminn.permissions.status({ capability: "network", scope: providerScope() });
        networkGrant = networkAuthorization.grant || "unknown";
      } catch (_) {
        networkGrant = "unknown";
      }
      const serviceReady = status.accessibilityEnabled && status.serviceConnected;
      setStatus("accessibility", !status.supported ? "版本不支持" : serviceReady ? "已连接" :
        status.accessibilityEnabled ? "正在连接" : "未启用", !status.supported ? "bad" : serviceReady ? "good" : "wait");
      setStatus("authorization", grant === "allow" ? "已授权" : grant === "deny" ? "已拒绝" : "待授权",
        grant === "allow" ? "good" : grant === "deny" ? "bad" : "wait");
      setStatus("overlay", status.hasOverlay ? "已运行" : "未创建", status.hasOverlay ? "good" : "wait");
      setStatus("model", !provider ? "未配置" : modelConnectionVerified ? "已连接" :
        networkGrant === "deny" ? "网络未授权" : modelTestFailed ? "测试失败" : "待测试",
      !provider || networkGrant === "deny" || modelTestFailed ? "bad" : modelConnectionVerified ? "good" : "wait");
      updateProviderLabel();
      updateControls();
      if (preserveMessage) return;
      if (!status.supported) {
        $("#overall-status").textContent = "不支持";
        setMessage("屏幕交互需要 Android 11 或更新版本。", "error");
      } else if (grant === "deny") {
        $("#overall-status").textContent = "需授权";
        setMessage("ImHamster 的屏幕权限已拒绝；请在 Haminn 权限管理中重置后重试。", "wait");
      } else if (grant !== "allow") {
        $("#overall-status").textContent = "需授权";
        setMessage("ImHamster 授权只确认此 Happ 可调用 Haminn 屏幕操作。", "wait");
      } else if (!status.accessibilityEnabled) {
        $("#overall-status").textContent = "需开启服务";
        setMessage("此 Happ 已授权。还需在 Android 设置中启用 Haminn 屏幕服务。", "wait");
      } else if (!status.serviceConnected) {
        $("#overall-status").textContent = "连接中";
        setMessage("Android 开关已启用，Haminn 屏幕服务正在连接。", "wait");
      } else if (!provider) {
        $("#overall-status").textContent = "模型未配置";
        setMessage("没有读取到可用的模型配置。", "error");
      } else if (networkGrant !== "allow") {
        $("#overall-status").textContent = "待配置";
        setMessage("授予模型服务的网络权限后，页面会先测试截图识别。", "wait");
      } else if (!modelConnectionVerified) {
        $("#overall-status").textContent = modelTestFailed ? "测试失败" : "待测试";
        if (!preserveMessage) setMessage(modelTestFailed ? "模型测试失败；点下方按钮重试。" : `点下方按钮测试 ${provider?.displayName || provider?.model || "模型"}。`, modelTestFailed ? "error" : "wait");
      } else if (!status.hasOverlay) {
        $("#overall-status").textContent = "待创建浮球";
        setMessage("模型接口已验证；点下方按钮创建悬浮球。", "success");
      } else {
        $("#overall-status").textContent = "已就绪";
        setMessage("点悬浮球，输入你希望手机完成的目标。", "success");
      }
    } catch (error) {
      $("#overall-status").textContent = "状态读取失败";
      if (!preserveMessage) setMessage(error.message || "无法读取设备状态。", "error");
    }
  }

  async function continueSetup() {
    if (operationRunning) return;
    if (!consent.checked) {
      setMessage("请先勾选同意项。", "wait");
      return;
    }
    operationRunning = true;
    backgroundHandedOff = false;
    let modelTestStarted = false;
    updateControls();
    try {
      status = await haminn.interaction.status();
      if (!status.supported) throw new Error("屏幕交互需要 Android 11 或更新版本。");
      if (status.authorization?.grant !== "allow") {
        setMessage("正在请求 ImHamster 的屏幕操作权限…", "wait");
        await haminn.permissions.request({ capability: "screen.interaction" });
        status = await haminn.interaction.status();
        if (status.authorization?.grant !== "allow") throw new Error("ImHamster 屏幕操作权限尚未授予。");
      }

      if (!status.accessibilityEnabled) {
        setMessage("正在打开 Android 无障碍设置；请启用“Haminn 屏幕交互”后返回。", "wait");
        await haminn.interaction.openAccessibilitySettings();
        return;
      }
      if (!status.serviceConnected) {
        await refreshStatus();
        if (!status?.serviceConnected) throw new Error("Haminn 屏幕服务尚未连接；请确认系统无障碍开关已启用后重试。");
      }
      if (!provider) throw new Error("模型配置未就绪；没有创建悬浮球。");

      const networkAuthorization = await haminn.permissions.request({ capability: "network", scope: providerScope() });
      if (networkAuthorization?.grant && networkAuthorization.grant !== "allow") {
        throw new Error("模型服务网络权限尚未授予；没有请求模型。");
      }
      const currentNetwork = await haminn.permissions.status({ capability: "network", scope: providerScope() });
      networkGrant = currentNetwork.grant || "unknown";
      if (networkGrant !== "allow") throw new Error("模型服务网络权限尚未授予；没有请求模型。");

      if (!modelConnectionVerified) {
        setMessage(`正在设备上测试 ${provider.displayName || provider.model} 截图识别…`, "wait");
        setStatus("model", "正在测试", "wait");
        modelTestFailed = false;
        modelTestStarted = true;
        await testModelConnection();
      }
      status = await haminn.interaction.status();
      if (!status.hasOverlay) {
        setMessage("模型接口已验证，正在创建悬浮球…", "wait");
        await haminn.overlay.create({ label: "H", color: BASE_BUBBLE_COLOR });
        await haminn.data.put({ collection: "screen-interaction", key: "overlay", value: { createdAt: Date.now() } });
      }
      await refreshStatus();
      setMessage("设置完成。点悬浮球并输入操作目标。", "success");
    } catch (error) {
      if (modelTestStarted && !modelConnectionVerified) modelTestFailed = true;
      setMessage(error.message || "设置未完成。", "error");
    } finally {
      operationRunning = false;
      await refreshStatus({ preserveMessage: true });
      updateControls();
    }
  }

  async function captureFrame({ maxEdge = 800, quality = 45, settleMs = SETTLE_MS } = {}) {
    assertSubmissionTime();
    const remaining = remainingSubmissionMs();
    const limitedBySubmission = remaining <= SCREENSHOT_TIMEOUT_MS;
    const deadline = Date.now() + Math.min(SCREENSHOT_TIMEOUT_MS, remaining);
    const capture = (params) => withTimeout(haminn.interaction.capture(params), Math.max(1, deadline - Date.now()),
      limitedBySubmission ? SUBMISSION_TIMEOUT_MESSAGE : `屏幕截图超过 ${SCREENSHOT_TIMEOUT_MS / 1000} 秒没有返回，已停止本次连通测试。`,
      limitedBySubmission ? "SUBMISSION_TIMEOUT" : "SCREENSHOT_TIMEOUT");
    let frame = await capture({ settleMs, maxEdge, quality });
    if (frame.dataBase64.length > 155_000 && maxEdge > 640) {
      frame = await capture({ settleMs: 600, maxEdge: 640, quality: 35 });
    }
    if (frame.dataBase64.length > 175_000) throw new Error("截图压缩后仍超出模型请求的安全大小，已停止操作。");
    return frame;
  }


  function isTransientModelError(error) {
    const code = String(error?.code || "");
    return ["NETWORK_REQUEST_FAILED", "MODEL_REQUEST_TIMEOUT", "E_TIMEOUT", "E_IO", "MODEL_RESPONSE_EMPTY"].includes(code) ||
      /^HTTP_(408|425|429|5\d\d)$/.test(code) || /connection reset|network|temporarily unavailable/i.test(error?.message || "");
  }

  async function requestModel(messages, options = {}) {
    const maxAttempts = 3;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await requestModelOnce(messages, options);
      } catch (error) {
        if (attempt >= maxAttempts || !isTransientModelError(error)) throw error;
        const delayMs = Math.min(3000, 600 * (2 ** (attempt - 1)));
        await recordTrace({ phase: "model-retry", attempt, delayMs, code: String(error.code || "network_error").slice(0, 48) });
        setMessage(`模型或网络暂时中断，${Math.ceil(delayMs / 1000)} 秒后自动重试 ${attempt}/${maxAttempts - 1}；屏幕动作尚未重复。`, "wait");
        await sleep(delayMs);
        assertSubmissionTime();
      }
    }
  }

  async function requestModelOnce(messages, { timeoutMs = VISION_REQUEST_TIMEOUT_MS, purpose = "模型请求", targetProvider = provider } = {}) {
    if (!targetProvider) throw new Error("模型配置尚未就绪。");
    // CodeBestie's working Chat Completions request uses only model + messages.
    // Do not add optional fields (for example stream/reasoning_effort/max_tokens)
    // unless the provider explicitly documents and this device verifies them.
    let response;
    try {
      const request = haminn.network.request({
        url: providerEndpoint(targetProvider),
        method: "POST",
        headers: {
          Authorization: `Bearer ${targetProvider.apiKey}`,
          Accept: "application/json",
          "User-Agent": API_UA,
        },
        contentType: "application/json",
        bodyText: JSON.stringify({
          model: targetProvider.model,
          messages,
        }),
        timeoutMs,
      });
      const bridgeDeadlineMs = Math.min(MODEL_BRIDGE_DEADLINE_MS, timeoutMs + 9_000, remainingSubmissionMs());
      response = await withTimeout(request, Math.max(1, bridgeDeadlineMs),
        bridgeDeadlineMs < timeoutMs + 9_000 ? SUBMISSION_TIMEOUT_MESSAGE : `${purpose}超过等待时限，已停止本次连通测试。`,
        bridgeDeadlineMs < timeoutMs + 9_000 ? "SUBMISSION_TIMEOUT" : "MODEL_REQUEST_TIMEOUT");
    } catch (error) {
      if (error?.code === "MODEL_REQUEST_TIMEOUT" || /timeout|timed out/i.test(error?.message || "") || error?.code === "E_TIMEOUT") {
        await recordTrace({ phase: "model-timeout", purpose, timeoutMs, deadlineMs: Math.min(MODEL_BRIDGE_DEADLINE_MS, timeoutMs + 9_000) });
        const timeout = new Error(`${purpose}超时；本轮已停止，没有继续执行屏幕动作。`);
        timeout.code = "MODEL_REQUEST_TIMEOUT";
        throw timeout;
      }
      if (error && !error.code) error.code = "NETWORK_REQUEST_FAILED";
      throw error;
    }
    const statusCode = Number(response?.status);
    if (!Number.isFinite(statusCode)) {
      throw new Error(`Haminn 网络 Bridge 响应缺少 HTTP 状态码（返回字段=${Object.keys(response || {}).join(",") || "none"}）。`);
    }
    let responseText = typeof response.bodyText === "string" ? response.bodyText : "";
    if (!responseText && response.file?.logicalFileId) {
      const logicalFileId = response.file.logicalFileId;
      try {
        const storedResponse = await submissionCall(() => haminn.files.readText({ logicalFileId, maxBytes: 1024 * 1024 }),
          5000, "读取模型响应文件超时。", "MODEL_RESPONSE_READ_TIMEOUT");
        responseText = storedResponse.text || "";
      } finally {
        await withTimeout(haminn.files.delete({ logicalFileId }), 1200, "清理模型响应文件超时", "FILE_CLEANUP_TIMEOUT").catch(() => {});
      }
    }
    if (!responseText && typeof response.bodyBase64 === "string") {
      const binary = atob(response.bodyBase64);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      responseText = new TextDecoder("utf-8").decode(bytes);
    }
    if (response.status < 200 || response.status >= 300) {
      let detail = "";
      try {
        const errorBody = JSON.parse(responseText || "{}");
        const reason = errorBody?.error?.message || errorBody?.message || errorBody?.error;
        detail = typeof reason === "string" ? reason : reason ? JSON.stringify(reason) : "";
      } catch (_) {
        detail = responseText.trim().slice(0, 240);
      }
      detail = detail.replace(/sk-[A-Za-z0-9_-]{16,}/g, "[密钥已隐藏]").slice(0, 240);
      const httpError = new Error(`模型接口返回 HTTP ${response.status}${detail ? `：${detail}` : ""}；没有执行本步屏幕操作。`);
      httpError.code = `HTTP_${statusCode}`;
      throw httpError;
    }
    if (!responseText.trim()) {
      const emptyError = new Error(`模型接口返回空正文（Bridge字段=${Object.keys(response).join(",")}，HTTP ${statusCode}）；没有执行本步屏幕操作。`);
      emptyError.code = "MODEL_RESPONSE_EMPTY";
      throw emptyError;
    }
    let data;
    try { data = JSON.parse(responseText); }
    catch {
      const jsonError = new Error("模型接口返回内容不是有效 JSON；没有执行本步屏幕操作。");
      jsonError.code = "MODEL_RESPONSE_INVALID_JSON";
      throw jsonError;
    }
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content === "string" && content) return content;
    if (Array.isArray(content)) {
      const text = content.map((part) => part?.text || "").join("\n");
      if (text) return text;
    }
    const messageFields = choice?.message && typeof choice.message === "object"
      ? Object.keys(choice.message).join(",") : "none";
    const contentError = new Error(`模型响应中没有可读文本（message字段=${messageFields}，finish=${choice?.finish_reason || "none"}，content类型=${typeof content}）；没有执行本步屏幕操作。`);
    contentError.code = `MODEL_RESPONSE_${String(choice?.finish_reason || "NO_TEXT").toUpperCase()}`;
    throw contentError;
  }

  async function testModelConnection(targetProvider = provider) {
    const probeFrame = await captureFrame({ maxEdge: 640, quality: 32 });
    await recordTrace({ phase: "vision-probe-start", imageBytes: probeFrame.dataBase64.length });
    const visionContent = await requestVisionContent(
      "这是设备截图视觉能力检查。只根据附图回答，严格只输出 JSON：{\"state\":\"ready\",\"evidence\":\"截图中一个清楚可见的短标题\"}。不要执行操作，不要输出截图以外的信息。",
      "请确认你收到并能读取这张设备截图。",
      probeFrame,
      { step: 0, label: `${targetProvider.displayName || targetProvider.model}视觉连通测试`, targetProvider },
    );
    const visionProbe = parseJsonContent(visionContent);
    if (visionProbe.state !== "ready" || typeof visionProbe.evidence !== "string" || !visionProbe.evidence.trim()) {
      throw new Error(`${targetProvider.displayName || targetProvider.model}请求成功，但截图识别测试未返回有效结果。`);
    }
    modelConnectionVerified = true;
    await haminn.data.put({
      collection: "screen-interaction",
      key: "model-check",
      value: { kind: "screen-vision-v1", model: targetProvider.model, baseUrl: targetProvider.baseUrl, checkedAt: Date.now() },
    }).catch(() => {});
    if (targetProvider === provider) setStatus("model", "视觉已验证", "good");
    await recordTrace({ phase: "vision-probe", status: "passed" });
  }

  async function verifyConfiguredModel() {
    if (operationRunning || modelConnectionVerified || !consent.checked || !provider || networkGrant !== "allow" ||
        !status?.accessibilityEnabled || !status?.serviceConnected) return;
    operationRunning = true;
    modelTestFailed = false;
    updateControls();
    await beginTrace("vision-probe");
    setMessage(`正在设备上验证 ${provider.displayName || provider.model} 的截图识别…`, "wait");
    setStatus("model", "截图测试中", "wait");
    try {
      await testModelConnection();
      await finishTrace("passed");
      setMessage(`${provider.displayName || provider.model} 已通过设备截图识别测试。`, "success");
    } catch (error) {
      modelTestFailed = true;
      await finishTrace("failed", error);
      setMessage(error.message || `${provider.displayName || provider.model}截图识别测试失败。`, "error");
    } finally {
      operationRunning = false;
      await refreshStatus({ preserveMessage: true });
      updateControls();
    }
  }

  async function compareConfiguredProviders() {
    const candidates = configuredProviderCandidates();
    if (operationRunning || candidates.length < 2 || !consent.checked ||
        !status?.accessibilityEnabled || !status?.serviceConnected) return;
    const prior = await haminn.data.get({ collection: "screen-interaction", key: "provider-comparison" }).catch(() => null);
    if (prior?.value?.schemaVersion === 2 && Number.isFinite(prior.value.finishedAt) &&
        Date.now() - prior.value.finishedAt < 15 * 60_000) return;

    operationRunning = true;
    modelTestFailed = false;
    updateControls();
    const results = [];
    const probeStartedAt = Date.now();
    setMessage("正在用同一张设备截图对比配置的视觉模型…", "wait");
    try {
      const frame = await captureFrame({ maxEdge: 640, quality: 32 });
      const systemPrompt = "这是设备截图视觉能力检查。只根据附图回答，严格只输出 JSON：{\"state\":\"ready\",\"evidence\":\"截图中一个清楚可见的短标题\"}。不要执行操作，不要输出截图以外的信息。";
      const messages = visionMessages(systemPrompt, "请确认你收到并能读取这张设备截图。", frame);
      for (const candidate of candidates) {
        const result = {
          model: candidate.displayName || candidate.model,
          provider: providerScope(candidate),
          status: "failed",
        };
        const startedAt = Date.now();
        try {
          let grant = await haminn.permissions.status({ capability: "network", scope: result.provider });
          if (grant?.grant !== "allow") {
            await haminn.permissions.request({ capability: "network", scope: result.provider });
            grant = await haminn.permissions.status({ capability: "network", scope: result.provider });
          }
          if (grant?.grant !== "allow") {
            const denied = new Error("模型服务网络权限尚未授予。");
            denied.code = "NETWORK_AUTHORIZATION_REQUIRED";
            throw denied;
          }
          result.networkGrant = grant.grant;
          const content = await requestModel(messages, {
            timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
            purpose: `${result.model}同图截图识别测试`,
            targetProvider: candidate,
          });
          const probe = parseJsonContent(content);
          if (probe.state !== "ready" || typeof probe.evidence !== "string" || !probe.evidence.trim()) {
            const invalidProbe = new Error("截图识别结果不符合预期。");
            invalidProbe.code = "INVALID_VISION_PROBE";
            throw invalidProbe;
          }
          result.status = "passed";
          result.latencyMs = Date.now() - startedAt;
        } catch (error) {
          result.code = error.code || (/timeout/i.test(error.message || "") ? "MODEL_REQUEST_TIMEOUT" : "PROBE_FAILED");
          result.latencyMs = Date.now() - startedAt;
        }
        results.push(result);
        await haminn.data.put({ collection: "screen-interaction", key: "provider-comparison", value: {
          schemaVersion: 2,
          startedAt: probeStartedAt,
          providers: results,
          finishedAt: null,
        } }).catch(() => {});
      }

      const successful = results.filter((result) => result.status === "passed");
      if (!successful.length) {
        modelTestFailed = true;
        const permissionNeeded = results.some((result) => result.code === "NETWORK_AUTHORIZATION_REQUIRED");
        throw new Error(permissionNeeded
          ? "有模型服务尚未获得 Haminn 网络授权；允许该服务后即可继续比较。"
          : "配置的视觉模型都未能在设备截图测试中返回有效结果。请查看诊断记录。");
      }

      const selectedResult = successful.reduce((best, item) => item.latencyMs < best.latencyMs ? item : best);
      const selected = candidates.find((candidate) => (candidate.displayName || candidate.model) === selectedResult.model);
      if (selected) {
        provider = selected;
        await haminn.data.put({ collection: "screen-interaction", key: "provider", value: provider });
        await haminn.data.put({ collection: "screen-interaction", key: "model-check", value: {
          kind: "screen-vision-v1", model: provider.model, baseUrl: provider.baseUrl, checkedAt: Date.now(),
        } }).catch(() => {});
        modelConnectionVerified = true;
        modelTestFailed = false;
      }
      const comparison = results.map((result) => `${result.model}：${result.status === "passed" ? `${(result.latencyMs / 1000).toFixed(1)} 秒` : result.code || "失败"}`).join("；");
      await haminn.data.put({ collection: "screen-interaction", key: "provider-comparison", value: {
        schemaVersion: 2,
        startedAt: probeStartedAt,
        finishedAt: Date.now(),
        selectedModel: selectedResult.model,
        providers: results,
      } }).catch(() => {});
      setMessage(`同图设备测试：${comparison}。已选择 ${selectedResult.model}。`, "success");
    } catch (error) {
      modelTestFailed = true;
      await haminn.data.put({ collection: "screen-interaction", key: "provider-comparison", value: {
        schemaVersion: 2,
        startedAt: probeStartedAt,
        finishedAt: Date.now(),
        providers: results,
        error: error.code || (/timeout/i.test(error.message || "") ? "timeout" : "comparison_failed"),
      } }).catch(() => {});
      setMessage(error.message || "模型对比测试失败。", "error");
    } finally {
      operationRunning = false;
      await refreshStatus({ preserveMessage: true });
      updateControls();
    }
  }


  function parseJsonContent(content) {
    const cleaned = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) {
      const missingJson = new Error("模型没有返回 JSON 操作结果；为安全起见已停止。");
      missingJson.code = "MODEL_OUTPUT_NOT_JSON";
      throw missingJson;
    }
    try { return JSON.parse(cleaned.slice(start, end + 1)); }
    catch {
      const malformedJson = new Error("模型返回的 JSON 无法解析；为安全起见已停止。");
      malformedJson.code = "MODEL_OUTPUT_INVALID_JSON";
      throw malformedJson;
    }
  }

  function visionMessages(systemPrompt, text, frame) {
    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:${frame.mime};base64,${frame.dataBase64}` } },
      ] },
    ];
  }

  async function requestVisionContent(systemPrompt, text, frame, { step = null, label = "屏幕识别", targetProvider = provider } = {}) {
    const stepLabel = step ? `第 ${step} 轮` : "当前轮";
    assertSubmissionTime();
    const remaining = remainingSubmissionMs();
    const limitedBySubmission = remaining <= VISION_REQUEST_TIMEOUT_MS;
    const timeoutMs = Math.max(1, Math.min(VISION_REQUEST_TIMEOUT_MS, remaining));
    await setBubbleState(step ? `识${step}` : "识", "#c18122");
    setMessage(`${label}${step ? stepLabel : ""}：等待模型识别，最多 ${Math.ceil(timeoutMs / 1000)} 秒。`, "wait");
    try {
      return await requestModel(visionMessages(systemPrompt, text, frame), { timeoutMs, purpose: `${label}${step ? `第${step}轮截图识别` : ""}`, targetProvider });
    } catch (error) {
      if (limitedBySubmission && error.code === "MODEL_REQUEST_TIMEOUT") {
        error.code = "SUBMISSION_TIMEOUT";
        error.message = SUBMISSION_TIMEOUT_MESSAGE;
      }
      if (error.code !== "MODEL_REQUEST_TIMEOUT") {
        await recordTrace({ phase: "model-error", step, code: error.code || "request_error" });
        throw error;
      }
      await recordTrace({ phase: "model-dispatch-stopped", step, imageBytes: frame.dataBase64.length });
      throw error;
    }
  }

  function normalizeInstruction(value) { return String(value || "").replace(/\s+/g, " ").trim(); }


  async function setBubbleState(label, color) {
    try {
      await withTimeout(haminn.overlay.update({ label, color }), 1500, "悬浮球状态更新超时", "OVERLAY_UPDATE_TIMEOUT");
    } catch (_) { /* preserve the existing bubble if transiently unavailable */ }
  }

  // The public Bridge cannot cancel a request after sending it. Use this only around
  // screenshots and model reads: when the local deadline wins, that late response is
  // ignored and the task never reaches the next screen action.
  function withTimeout(promise, timeoutMs, messageText, code) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(messageText);
        error.code = code;
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
  }

  async function saveLastResult(result) {
    lastResult = result;
    await withTimeout(haminn.data.put({ collection: "screen-interaction", key: "last-run", value: result }),
      1500, "任务结果写入超时", "RESULT_WRITE_TIMEOUT").catch(() => {});
    const line = $("#last-result");
    if (line) line.textContent = result.traceSummary ? `${result.summary} · ${result.traceSummary}` : result.summary;
  }

  function workerStateLabel(value, serviceState) {
    if (value === "paused") return "已暂停";
    if (value === "waiting") return "等待处理";
    if (value === "done") return "已完成";
    if (value === "failed") return "执行失败 · 可重试";
    if (value === "cancelled") return "已取消";
    if (value === "active" || value === "running") return serviceState === "running" ? "运行中" : "可继续";
    return value || "待处理";
  }

  function renderWorkerPanel(activeRecord, queuedCount, serviceState, serviceError = "", eventTasks = []) {
    if (!workerPanel) return;
    const active = activeRecord?.value || null;
    const liveEventTasks = eventTasks.map(item => item?.value).filter(item => item && item.state !== "cancelled");
    const visible = (!!active && !["done", "failed", "cancelled"].includes(active.state)) || queuedCount > 0 || !!active?.trace?.length || liveEventTasks.length > 0;
    workerPanel.hidden = !visible;
    if (!visible) return;
    const stateValue = active?.state || "queued";
    const goalId = String(active?.goalId || "");
    if (goalId !== workerJournalGoalId) {
      workerJournalGoalId = goalId;
      if (workerJournalDetails) {
        workerJournalDetails.open = false;
        workerJournalDetails.hidden = !goalId;
      }
      if (workerJournalEvents) workerJournalEvents.textContent = "展开后读取事件记录";
    }
    const acceptedAt = Number(lastResult?.acceptedAt || 0);
    const persistedCurrentGoal = !!active && active.intent === lastResult?.goalIntent &&
      Number(active.createdAt || 0) >= acceptedAt - 5000;
    const interruptedHandoff = serviceState === "failed" && lastResult?.status === "running" &&
      (!persistedCurrentGoal || !["done", "failed", "cancelled"].includes(active?.state));
    const activeEventTask = active?.state === "event-driven";
    const runningEventCount = liveEventTasks.filter(item => ["active", "registering", "pausing", "cancelling"].includes(item.state)).length;
    workerStateLine.textContent = interruptedHandoff ? "后台执行中断"
      : activeEventTask ? "事件任务持续监控中"
        : queuedCount && !active ? `${queuedCount} 项排队` : workerStateLabel(stateValue, serviceState);
    const lines = [];
    if (interruptedHandoff) lines.push(`后台 Worker 已异常退出：${String(serviceError || "原因未报告").slice(0, 240)}。请先核对目标应用当前状态，再决定是否重试。`);
    if (active?.intent) lines.push(active.intent.slice(0, 180));
    const actionLoop = active?.actionLoop || active?.loop;
    if (actionLoop) lines.push(`AL ${actionLoop.index || 1}：预估 ${actionLoop.estimatedMinutes || "待定"} 分钟 / 预算 ${actionLoop.budgetMinutes || 15} 分钟`);
    if (Number.isFinite(active?.goalDeadlineAt) && !["done", "failed", "cancelled", "event-driven"].includes(active.state)) {
      lines.push(`单次目标剩余 ${Math.max(0, Math.ceil((active.goalDeadlineAt - Date.now()) / 60_000))} 分钟（上限 30 分钟）`);
    }
    if (active?.progress) lines.push(active.progress.slice(0, 240));
    if (active?.waiting?.question) lines.push(`需要你确认：${String(active.waiting.question).slice(0, 180)}`);
    if (runningEventCount) lines.push(`${runningEventCount} 项 EDT 正在等待事件触发`);
    if (workerReplyInput) workerReplyInput.hidden = !active?.waiting?.question || activeEventTask;
    if (queuedCount) lines.push(`${queuedCount} 项等待执行`);
    workerProgressLine.textContent = lines.join(" · ") || "尚无后台任务";
    renderEventTasks(eventTasks);
    if (workerTraceLine) {
      const labels = {
      "goal.accepted": "接收 OST", "model.ready": "模型就绪", "screenshot.requested": "请求截图",
        "screenshot.received": "收到截图", "model.requested": "请求模型", "model.responded": "模型返回",
        "decision": "模型决策", "model.error": "模型处理错误", "bridge.dispatched": "派发操作", "bridge.result": "操作回执", "worker.error": "执行错误",
        "recovery.scheduled": "安排恢复", "action-loop.repetition": "重复动作", "loop.repetition": "重复动作", "screen.unchanged": "画面未变",
        "action-loop.planning": "规划 AL", "loop.planning": "规划 AL", "action-loop.started": "AL 开始", "loop.started": "AL 开始", "action-loop.timeout": "AL 预算检查点", "loop.timeout": "AL 预算检查点", "action-loop.review": "LLM 复盘决定", "loop.review": "LLM 复盘决定",
        "goal.time-limit-exceeded": "目标超时停止", "goal.retry-attempt": "重新开始目标", "learning.review-complete": "经验整理完成", "learning.review-skipped": "跳过经验整理",
      };
      const events = Array.isArray(active?.trace) ? active.trace.slice(-8) : [];
      const detail = (event) => {
        if (event.phase === "decision") {
          const action = event.actionType ? ` ${event.actionType}${event.label ? `「${event.label}」` : ""}${Number.isFinite(event.x) ? ` @${event.x.toFixed(2)},${Number(event.y).toFixed(2)}` : ""}` : "";
          return `${event.decision || "?"}${action}${event.evidence ? `：${event.evidence}` : ""}`;
        }
        if (event.phase === "screenshot.received") return `${event.width || "?"}×${event.height || "?"}，${event.bytes || 0} B`;
        if (event.phase === "model.responded") return `HTTP ${event.httpStatus ?? "?"}${event.responseBytes ? `，${event.responseBytes} 字符` : ""}`;
        if (event.phase === "bridge.dispatched" || event.phase === "bridge.result") return `${event.actionType || "操作"}${event.label ? `「${event.label}」` : ""}${event.phase === "bridge.result" ? `，completed=${event.completed} / accepted=${event.accepted}${event.targeting ? ` / targeting=${event.targeting}` : ""}` : ""}`;
        if (event.phase === "worker.error" || event.phase === "model.error") return `${event.stage ? `${event.stage}：` : ""}${event.code ? `[${event.code}] ` : ""}${event.message || "未知错误"}`;
        if (event.phase === "recovery.scheduled") return `${event.mode === "reobserve" ? "立即重新观察" : "退避后重试"}（第 ${event.attempt} 次）`;
        if (event.phase === "loop.repetition" || event.phase === "action-loop.repetition" || event.phase === "screen.unchanged") return `连续 ${event.count} 次`;
        if (event.model) return event.model;
        return "";
      };
      workerTraceLine.hidden = !events.length;
      workerTraceLine.textContent = events.map((event) =>
        `#${event.step || 0} ${labels[event.phase] || event.phase}${detail(event) ? `：${detail(event)}` : ""}`
      ).join("\n");
    }
    const busy = workerControlBusy;
    const activeCanControl = !!active && !["done", "cancelled", "event-driven"].includes(active.state);
    workerPauseButton.disabled = busy || !activeCanControl || active.state === "paused";
    workerResumeButton.disabled = busy || !activeCanControl || (active.state !== "paused" && !active?.waiting?.userRequired && active.state !== "failed" && serviceState === "running");
    workerResumeButton.textContent = active?.state === "failed" || active?.waiting?.userRequired ? "检查后重试" : "继续";
    workerCancelButton.disabled = busy || (!activeCanControl && queuedCount === 0 && liveEventTasks.length === 0);
  }

  function eventTaskStateLabel(value) {
    return ({ active: "监控中", registering: "正在启用", paused: "已暂停", cancelled: "已取消",
      "needs-app-authorization": "需要 happ 授权", "needs-system-access": "需要 Android 通知授权",
      "needs-user": "需要补充信息" })[value] || value || "未知状态";
  }

  function renderEventTasks(items) {
    if (!workerEventTasks) return;
    workerEventTasks.replaceChildren();
    const current = (items || []).map(item => item?.value).filter(Boolean)
      .filter(item => item.state !== "cancelled");
    workerEventTasks.hidden = current.length === 0;
    for (const task of current) {
      const card = document.createElement("div");
      card.className = "worker-event-task";
      const title = document.createElement("div");
      title.className = "worker-event-task-title";
      title.textContent = `${eventTaskStateLabel(task.state)} · ${String(task.intent || "事件任务").slice(0, 180)}`;
      card.append(title);
      const sourcePackages = task.trigger?.sourcePackages || [];
      const meta = document.createElement("div");
      meta.className = "worker-event-task-meta";
      meta.textContent = `${task.trigger?.description || "等待触发条件"}${sourcePackages.length ? ` · 来源 ${sourcePackages.join("、")}` : ""}${task.missedNotifications ? ` · 遗漏 ${task.missedNotifications} 条` : ""}`;
      card.append(meta);
      if (task.lastControlError) {
        const controlError = document.createElement("div");
        controlError.className = "worker-event-task-meta worker-event-task-error";
        controlError.textContent = `控制操作未完成：${String(task.lastControlError).slice(0, 220)}`;
        card.append(controlError);
      }
      if (task.lastQuestion) {
        const question = document.createElement("div");
        question.className = "worker-event-task-meta";
        question.textContent = `需要补充：${String(task.lastQuestion).slice(0, 240)}`;
        card.append(question);
        const reply = document.createElement("textarea");
        reply.className = "worker-event-task-reply";
        reply.dataset.eventTaskReply = task.eventTaskId;
        reply.maxLength = 1200;
        reply.rows = 2;
        reply.placeholder = "补充触发条件或处理方式";
        card.append(reply);
      }
      const actions = document.createElement("div");
      actions.className = "worker-event-task-actions";
      const addAction = (command, label, primary = false) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `button ${primary ? "primary" : "secondary"}`;
        button.textContent = label;
        button.dataset.eventTaskCommand = command;
        button.dataset.eventTaskId = task.eventTaskId;
        actions.append(button);
      };
      if (task.state === "active") addAction("pause", "暂停");
      if (task.state === "registering") {
        if (task.lastControl === "resume") addAction("resume", "重试启用", true);
        else addAction("pause", "暂停");
      }
      if (task.state === "pausing") addAction("pause", "重试暂停", true);
      if (task.state === "paused") addAction("resume", "继续", true);
      if (task.state === "needs-user") addAction("resume", "补充并继续", true);
      if (["needs-app-authorization", "needs-system-access"].includes(task.state)) addAction("authorize", "授权并继续", true);
      if (task.state !== "cancelled" && task.state !== "cancelling") addAction("cancel", "取消");
      if (task.state === "cancelling") addAction("cancel", "重试取消", true);
      card.append(actions);
      workerEventTasks.append(card);
    }
  }

  async function readWorkerTaskState() {
    const [active, queue, service, eventTasks] = await Promise.all([
      haminn.data.get({ collection: "agent-runtime", key: "active-goal" }),
      haminn.data.scan({ collection: "inbox", prefix: "q:", limit: 100 }),
      haminn.workers.status(),
      haminn.data.scan({ collection: "event-tasks", prefix: "ed:", limit: 100 }),
    ]);
    return { active, queuedCount: Array.isArray(queue?.items) ? queue.items.length : 0,
      eventTasks: Array.isArray(eventTasks?.items) ? eventTasks.items : [],
      serviceState: service?.state || "stopped", serviceError: service?.error || "" };
  }

  function setMemoryNotice(text, tone = "") {
    if (!memoryNotice) return;
    memoryNotice.textContent = text;
    memoryNotice.dataset.tone = tone;
  }

  function memoryButton(label, action, key, className = "button secondary") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.dataset.memoryAction = action;
    button.dataset.memoryKey = key;
    button.disabled = memoryLoading;
    return button;
  }

  function renderMemoryList() {
    if (!memoryList) return;
    memoryList.replaceChildren();
    for (const record of memoryRecords) {
      const value = record?.value;
      if (!record?.key || value?.type !== "memory") continue;
      const entry = document.createElement("article");
      entry.className = "memory-entry";
      const title = document.createElement("p");
      title.className = "memory-entry-title";
      title.textContent = (Array.isArray(value.objectRefs) ? value.objectRefs : []).join("、") || "未标注对象";
      entry.append(title);
      const meta = document.createElement("p");
      meta.className = "memory-entry-meta";
      const kind = value.kind === "episode" ? "经历" : "事实";
      const inference = value.inference === "inferred" ? "推断" : "观察记录";
      const observedAt = Number(value.observedAt);
      const date = Number.isFinite(observedAt) && observedAt > 0 ? new Date(observedAt).toLocaleString() : "时间未知";
      meta.textContent = kind + " · " + inference + " · 来源 " + (Array.isArray(value.sourceRefs) ? value.sourceRefs.length : 0) + " 条 · " + date;
      entry.append(meta);

      if (memoryEditingKey === record.key) {
        const content = document.createElement("textarea");
        content.className = "memory-entry-editor";
        content.maxLength = 800;
        content.dataset.memoryContent = "true";
        content.setAttribute("aria-label", "记忆内容");
        content.value = String(value.content || "");
        const objects = document.createElement("input");
        objects.className = "memory-entry-objects";
        objects.type = "text";
        objects.maxLength = 1000;
        objects.dataset.memoryObjects = "true";
        objects.setAttribute("aria-label", "对象范围，使用逗号分隔");
        objects.value = (Array.isArray(value.objectRefs) ? value.objectRefs : []).join(", ");
        const fields = document.createElement("div");
        fields.append(content, objects);
        const actions = document.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(memoryButton("保存修订", "save", record.key), memoryButton("取消", "cancel-edit", record.key));
        entry.append(fields, actions);
      } else {
        const content = document.createElement("p");
        content.className = "memory-entry-content";
        content.textContent = String(value.content || "");
        entry.append(content);
        const actions = document.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(memoryButton("修订", "edit", record.key), memoryButton("删除", "delete", record.key, "button danger"));
        if (memoryDeleteConfirmKey === record.key) {
          actions.append(memoryButton("确认删除", "confirm-delete", record.key, "button danger"), memoryButton("取消", "cancel-delete", record.key));
        }
        entry.append(actions);
      }
      memoryList.append(entry);
    }
    if (memoryLoadMoreButton) {
      memoryLoadMoreButton.hidden = !memoryNextAfterKey;
      memoryLoadMoreButton.disabled = memoryLoading;
    }
  }

  async function loadMemoryPage({ append = false } = {}) {
    if (!window.haminn?.isReady || memoryLoading) return;
    if (!append) {
      memoryRecords = [];
      memoryNextAfterKey = null;
      memoryLoaded = false;
      memoryEditingKey = "";
      memoryDeleteConfirmKey = "";
      if (memoryList) memoryList.replaceChildren();
    }
    memoryLoading = true;
    if (memoryRefreshButton) memoryRefreshButton.disabled = true;
    if (memoryLoadMoreButton) memoryLoadMoreButton.disabled = true;
    setMemoryNotice(append ? "正在读取更多记忆…" : "正在读取本机记忆…");
    try {
      const page = await haminn.data.scan({ collection: "knowledge", prefix: "memory:", limit: 100,
        ...(append && memoryNextAfterKey ? { afterKey: memoryNextAfterKey } : {}) });
      const incoming = Array.isArray(page?.items) ? page.items.filter(item => item?.value?.type === "memory") : [];
      const known = new Set(memoryRecords.map(item => item.key));
      for (const item of incoming) if (item?.key && !known.has(item.key)) memoryRecords.push(item);
      memoryNextAfterKey = page?.nextAfterKey || null;
      memoryLoaded = true;
      const tail = memoryNextAfterKey ? "；可继续加载" : "";
      setMemoryNotice(memoryRecords.length ? "已读取 " + memoryRecords.length + " 条记忆" + tail + "。" : "当前没有已保存的记忆。");
      renderMemoryList();
    } catch (error) {
      setMemoryNotice("读取记忆失败：" + String(error?.message || error).slice(0, 240), "error");
    } finally {
      memoryLoading = false;
      if (memoryRefreshButton) memoryRefreshButton.disabled = !ready;
      renderMemoryList();
    }
  }

  async function handleMemoryAction(button) {
    if (!window.haminn?.isReady || memoryLoading) return;
    const key = button.dataset.memoryKey || "";
    const action = button.dataset.memoryAction || "";
    const record = memoryRecords.find(item => item.key === key);
    if (!record) return;
    if (action === "edit") {
      memoryEditingKey = key;
      memoryDeleteConfirmKey = "";
      renderMemoryList();
      return;
    }
    if (action === "cancel-edit") {
      memoryEditingKey = "";
      renderMemoryList();
      return;
    }
    if (action === "delete") {
      memoryDeleteConfirmKey = key;
      memoryEditingKey = "";
      renderMemoryList();
      return;
    }
    if (action === "cancel-delete") {
      memoryDeleteConfirmKey = "";
      renderMemoryList();
      return;
    }
    if (action === "save") {
      const entry = button.closest(".memory-entry");
      const content = entry?.querySelector("[data-memory-content]")?.value?.trim() || "";
      const rawRefs = entry?.querySelector("[data-memory-objects]")?.value || "";
      const objectRefs = [...new Set(rawRefs.split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
      if (!content || content.length > 800 || !objectRefs.length || objectRefs.length > 8 || objectRefs.some(value => value.length > 120)) {
        setMemoryNotice("请填写 1–800 字记忆内容，并设置 1–8 个不超过 120 字的对象范围。", "error");
        return;
      }
      memoryLoading = true;
      renderMemoryList();
      try {
        const value = { ...record.value, content, objectRefs, revision: Math.max(1, Number(record.value.revision) || 1) + 1, updatedAt: Date.now() };
        const updated = await haminn.data.put({ collection: "knowledge", key, value, expectedRevision: record.revision });
        record.value = value;
        record.revision = updated?.revision || record.revision;
        memoryEditingKey = "";
        setMemoryNotice("记忆已修订并保存。", "success");
      } catch (error) {
        setMemoryNotice("保存失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        memoryLoading = false;
        if (memoryRefreshButton) memoryRefreshButton.disabled = !ready;
        renderMemoryList();
      }
      return;
    }
    if (action === "confirm-delete") {
      memoryLoading = true;
      renderMemoryList();
      try {
        await haminn.data.delete({ collection: "knowledge", key, expectedRevision: record.revision });
        memoryRecords = memoryRecords.filter(item => item.key !== key);
        memoryDeleteConfirmKey = "";
        setMemoryNotice("记忆已删除。", "success");
      } catch (error) {
        setMemoryNotice("删除失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        memoryLoading = false;
        if (memoryRefreshButton) memoryRefreshButton.disabled = !ready;
        renderMemoryList();
      }
    }
  }

  async function loadWorkerJournal() {
    const goalId = workerJournalGoalId;
    if (!goalId || workerJournalLoading || !window.haminn?.isReady || !workerJournalEvents) return;
    workerJournalLoading = true;
    workerJournalEvents.textContent = "正在读取后台事件记录…";
    try {
      let afterKey;
      let pages = 0;
      let records = [];
      do {
        const page = await haminn.data.scan({ collection: "agent-events", prefix: `e:${goalId}:`, limit: 100,
          ...(afterKey ? { afterKey } : {}) });
        const items = Array.isArray(page?.items) ? page.items : [];
        records.push(...items);
        if (records.length > 500) records = records.slice(-500);
        afterKey = page?.nextAfterKey || null;
        pages += 1;
      } while (afterKey && pages < 10);
      if (goalId !== workerJournalGoalId) return;
      const lines = records.map(({ value = {} }) => {
        const at = Number(value.at);
        const time = Number.isFinite(at) ? new Date(at).toLocaleTimeString() : "--:--:--";
        const serialized = JSON.stringify(value);
        const detail = serialized.length > 1200 ? `${serialized.slice(0, 1200)}…[详情截断]` : serialized;
        return `${time} #${value.step || 0} ${value.phase || "event"} ${detail}`;
      });
      const notice = afterKey ? "达到单次读取上限；以下为已读取事件中的最后 500 条。" : `共 ${records.length} 条事件。`;
      workerJournalEvents.textContent = lines.length ? `${notice}\n${lines.join("\n")}` : "该 OST 尚无事件记录。";
    } catch (error) {
      workerJournalEvents.textContent = `事件记录读取失败：${String(error?.message || error).slice(0, 300)}`;
    } finally {
      workerJournalLoading = false;
    }
  }

  async function refreshWorkerPanel() {
    if (!ready || workerControlBusy || !window.haminn?.isReady) return;
    try {
      const task = await readWorkerTaskState();
      const active = task.active?.value;
      if (lastResult?.status === "running" && active?.state === "done" &&
          active.intent === lastResult.goalIntent && Number(active.createdAt || 0) >= Number(lastResult.acceptedAt || 0) - 5000) {
        await saveLastResult({ ...lastResult, status: "done", summary: active.progress || "模型已判断单次目标完成。",
          finishedAt: Number(active.updatedAt || Date.now()) });
      }
      renderWorkerPanel(task.active, task.queuedCount, task.serviceState, task.serviceError, task.eventTasks);
    } catch (_) { /* keep the last known task state during transient Bridge errors */ }
  }

  async function stopWorkerAndWait() {
    const initial = await haminn.workers.status();
    if (initial?.state !== "stopped" && initial?.state !== "failed") await haminn.workers.stop();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const current = await haminn.workers.status();
      if (current?.state === "stopped" || current?.state === "failed") return;
      await sleep(160);
    }
    throw new Error("后台 Worker 尚未确认停止；任务状态没有修改。");
  }

  async function startWorkerForGoalSubmission() {
    const current = await readWorkerTaskState();
    const active = current.active?.value;
    const goalTerminal = !active || ["done", "failed", "cancelled"].includes(active.state);
    const learningSettled = !["pending", "running"].includes(active?.learningStatus);
    // Retire only an idle terminal Worker; never discard an active OST, queued task, or pending ME review.
    if (current.serviceState === "running" && goalTerminal && learningSettled && current.queuedCount === 0) {
      await stopWorkerAndWait();
    }
    return submissionCall(() => haminn.workers.start(), 12_000,
      "后台 Worker 启动请求超时。", "WORKER_START_TIMEOUT");
  }

  async function ensureWorkerRunningForControl() {
    let current = await haminn.workers.status();
    if (current?.state !== "running") current = await startWorkerForGoalSubmission();
    const deadline = Date.now() + 12_000;
    while (current?.state !== "running" && Date.now() < deadline) {
      if (["failed", "stopped", "waiting-user"].includes(current?.state)) {
        throw new Error(current.error || `后台 Worker 无法处理事件任务（${current.state}）。`);
      }
      await sleep(200);
      current = await haminn.workers.status();
    }
    if (current?.state !== "running") throw new Error("后台 Worker 启动超时；事件任务控制已保留，可重试。");
    return current;
  }

  async function dispatchEventTaskControl(eventTaskId, command, reply = "", { startWorker = true } = {}) {
    const identity = { eventTaskId, command, reply: String(reply || "").trim().slice(0, 1200) };
    if (startWorker) {
      const current = await readWorkerTaskState();
      const active = current.active?.value;
      hoControlModule ||= import("./agent/ho/control.mjs");
      const { shouldFenceWorkerForEventTaskControl } = await hoControlModule;
      if (current.serviceState === "running" && shouldFenceWorkerForEventTaskControl(active, eventTaskId, command)) {
        // Stop the matching EDT or its active child OST so startup applies the durable control before resuming work.
        await stopWorkerAndWait();
      }
    }
    const eventId = await prepareDispatchEventId("event-task.control", identity);
    const dispatched = await submissionCall(() => haminn.workers.dispatch({ event: {
      type: "event-task.control", ...identity, eventId,
    } }), 5000, "事件任务控制投递超时；可重新点击同一控制按钮。", "WORKER_EVENT_CONTROL_TIMEOUT");
    if (!dispatched?.accepted) throw new Error(`后台 Worker 未接收事件任务控制（${dispatched?.state || "未知状态"}）。`);
    await clearDispatchEventId("event-task.control", eventId);
    if (!startWorker) return { eventId, queued: true };
    await ensureWorkerRunningForControl();
    const expected = command === "pause" ? new Set(["paused"])
      : command === "cancel" ? new Set(["cancelled"])
        : new Set(["active", "needs-user", "needs-app-authorization", "needs-system-access"]);
    const deadline = Date.now() + 6000;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await haminn.data.get({ collection: "event-tasks", key: `ed:${eventTaskId}` });
      const task = latest?.value;
      if (task?.lastControlEventId === eventId && (expected.has(task.state) || task.lastControlError)) break;
      await sleep(200);
    }
    return latest?.value || null;
  }

  async function authorizeEventTask(task) {
    let authorization = await haminn.permissions.status({ capability: "notifications.listen" });
    if (authorization?.grant !== "allow") {
      await haminn.permissions.request({ capability: "notifications.listen" });
      authorization = await haminn.permissions.status({ capability: "notifications.listen" });
    }
    if (authorization?.grant !== "allow") throw new Error("ImHamster 的通知读取能力尚未获准。");
    const status = await haminn.notifications.getStatus();
    if (!status?.listenerAccess) {
      await haminn.notifications.openListenerSettings();
      setMessage("已打开 Android 通知使用权设置；启用 Haminn 后返回 ImHamster，再点“授权并继续”。", "wait");
      return null;
    }
    return dispatchEventTaskControl(task.eventTaskId, "resume");
  }

  async function handleEventTaskControl(button) {
    if (workerControlBusy || !window.haminn?.isReady) return;
    const eventTaskId = String(button.dataset.eventTaskId || "");
    const command = String(button.dataset.eventTaskCommand || "");
    const card = button.closest(".worker-event-task");
    const reply = card?.querySelector("[data-event-task-reply]")?.value || "";
    if (!eventTaskId || !["pause", "resume", "cancel", "authorize"].includes(command)) return;
    workerControlBusy = true;
    try {
      const task = command === "authorize" ? await authorizeEventTask({ eventTaskId })
        : await dispatchEventTaskControl(eventTaskId, command, reply);
      if (!task && command === "authorize") return;
      const summary = task?.lastControlError ? `事件任务控制未完成：${task.lastControlError}，可重试。`
        : task?.state === "paused" ? "事件任务已暂停。"
          : task?.state === "cancelled" ? "事件任务已取消。"
            : task?.state === "needs-system-access" ? "请在 Android 通知使用权设置中允许 Haminn 后继续。"
              : task?.state === "needs-app-authorization" ? "ImHamster 仍缺少通知读取能力；请重试授权。"
                : task ? `事件任务状态：${eventTaskStateLabel(task.state)}。` : "控制指令已交给后台 Worker；状态正在同步。";
      setMessage(summary, task?.lastControlError ? "error" : "success");
    } catch (error) {
      setMessage(error.message || "事件任务控制失败，可重试。", "error");
    } finally {
      workerControlBusy = false;
      await refreshWorkerPanel();
    }
  }

  async function applyHoUserControl(command, reply = "") {
    hoControlModule ||= import("./agent/ho/control.mjs");
    const { applyUserControl } = await hoControlModule;
    return applyUserControl(haminn.data, { command, reply });
  }

  async function controlWorker(actionName) {
    if (workerControlBusy || !window.haminn?.isReady) return;
    workerControlBusy = true;
    renderWorkerPanel({ value: { state: "active" } }, 0, "running");
    try {
      if (actionName === "pause") {
        await stopWorkerAndWait();
        const control = await applyHoUserControl("pause");
        const summary = control.updated ? "后台任务已暂停，进度已保存。" : "后台 Worker 已停止；没有活动任务需要暂停。";
        if (control.updated) await saveLastResult({ status: "paused", summary, finishedAt: Date.now() });
        setMessage(summary, "success");
      } else if (actionName === "cancel") {
        const current = await readWorkerTaskState();
        const liveEventTasks = current.eventTasks.map(item => item?.value).filter(item => item && item.state !== "cancelled");
        await stopWorkerAndWait();
        const control = await applyHoUserControl("cancel");
        for (const task of liveEventTasks) {
          await dispatchEventTaskControl(task.eventTaskId, "cancel", "", { startWorker: false });
        }
        if (liveEventTasks.length) {
          await ensureWorkerRunningForControl();
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const remaining = await Promise.all(liveEventTasks.map(async task => {
              const latest = await haminn.data.get({ collection: "event-tasks", key: `ed:${task.eventTaskId}` });
              return latest?.value?.state !== "cancelled";
            }));
            if (!remaining.some(Boolean)) break;
            await sleep(250);
          }
          const stillLive = [];
          for (const task of liveEventTasks) {
            const latest = await haminn.data.get({ collection: "event-tasks", key: `ed:${task.eventTaskId}` });
            if (latest?.value?.state !== "cancelled") stillLive.push(task.eventTaskId);
          }
          if (stillLive.length) throw new Error(`部分事件任务尚未确认取消（${stillLive.length} 项）；后台控制已排队，可重试。`);
          await stopWorkerAndWait();
        }
        const summary = control.updated || control.queuedCancelled
          || liveEventTasks.length ? `已取消当前后台任务、${liveEventTasks.length} 项事件任务，并清除 ${control.queuedCancelled} 项排队任务。`
          : "后台 Worker 已停止；没有活动或排队任务需要取消。";
        await saveLastResult({ status: "cancelled", summary, finishedAt: Date.now() });
        setMessage(summary, "success");
      } else if (actionName === "resume") {
        const active = await haminn.data.get({ collection: "agent-runtime", key: "active-goal" });
        if (!active?.value || !["active", "running", "waiting", "paused", "failed"].includes(active.value.state)) {
          throw new Error("没有可继续的后台任务。");
        }
        const reply = String(workerReplyInput?.value || "").trim().slice(0, 1200);
        const shouldDispatchResume = ["waiting", "paused", "failed"].includes(active.value.state);
        const control = shouldDispatchResume ? await applyHoUserControl("resume", reply) : null;
        let started = await haminn.workers.status();
        const wasAlreadyRunning = started?.state === "running";
        if (!wasAlreadyRunning) started = await haminn.workers.start();
        if (started?.state === "waiting-user") throw new Error("后台运行授权尚未授予；任务没有继续。");
        const deadline = Date.now() + 12_000;
        let current = started;
        while (current?.state !== "running" && Date.now() < deadline) {
          if (["failed", "stopped", "waiting-user"].includes(current?.state)) throw new Error(current.error || `Worker 无法继续（${current.state}）。`);
          await sleep(200);
          current = await haminn.workers.status();
        }
        if (current?.state !== "running") throw new Error("后台 Worker 启动超时；任务仍保存在本机。");
        if (shouldDispatchResume && wasAlreadyRunning) {
          const eventId = await prepareDispatchEventId("goal.resume", { goalId: active.value.goalId, reply });
          const resumed = await submissionCall(() => haminn.workers.dispatch({ event: { type: "goal.resume", reply, eventId } }),
            5000, "任务恢复指令投递超时；进度仍保存在本机。", "WORKER_RESUME_TIMEOUT");
          if (!resumed?.accepted) throw new Error(`后台 Worker 未接受恢复指令（${resumed?.state || "未知状态"}）。`);
          await clearDispatchEventId("goal.resume", eventId);
        }
        const resumedIntent = control?.intent || active.value.intent;
        const summary = "后台任务已继续；正在重新观察屏幕并恢复进度。";
        if (workerReplyInput) workerReplyInput.value = "";
        await saveLastResult({ status: "running", summary, goalIntent: resumedIntent, acceptedAt: Date.now() });
        setMessage(summary, "success");
      }
    } catch (error) {
      setMessage(error.message || "后台任务控制失败。", "error");
    } finally {
      workerControlBusy = false;
      await refreshWorkerPanel();
    }
  }

  async function runFromOverlay(instructionOverride = null) {
    if (operationRunning) return;
    if (!consent.checked) {
      setMessage('尚未同意截图发送和跨应用屏幕操作。', 'wait');
      return;
    }
    if (!provider) {
      setMessage('模型配置未就绪；没有操作屏幕。', 'error');
      return;
    }

    operationRunning = true;
    updateControls();
    let instruction = '';
    activeTrace = null;
    try {
      await setBubbleState('问', '#4c7dff');
      if (typeof instructionOverride === 'string' && instructionOverride.trim()) {
        instruction = normalizeInstruction(instructionOverride);
      } else {
        const prompt = await haminn.overlay.prompt({
          title: '输入操作指令',
          message: '描述你希望在手机上完成的目标。',
          placeholder: '例如：打开微信，给 zhyuzh 回消息',
          submitLabel: '开始执行',
          cancelLabel: '取消',
          maxChars: 1200,
        });
        if (!prompt?.submitted || typeof prompt.text !== 'string' || !prompt.text.trim()) {
          setMessage('已取消，没有操作屏幕。', 'wait');
          await setBubbleState('H', BASE_BUBBLE_COLOR);
          return;
        }
        instruction = normalizeInstruction(prompt.text);
      }
        submissionDeadlineAt = Date.now() + SUBMISSION_TIMEOUT_MS;
        await beginTrace("screen-task", instruction);
      status = await submissionCall(() => haminn.interaction.status(), 5000, "屏幕交互状态检查超时。", "BRIDGE_TIMEOUT");
      if (!status.accessibilityEnabled || status.authorization?.grant !== 'allow' || !status.serviceConnected) {
        throw new Error('Haminn 屏幕交互服务或本 happ 授权不可用；没有操作屏幕。');
      }

      setMessage(`先从设备测试 ${provider.displayName || provider.model}；成功后才开始截图和触摸。`, 'wait');
      await submissionCall(() => haminn.permissions.request({ capability: 'network', scope: providerScope() }),
        12_000, "模型网络授权请求超时。", "BRIDGE_TIMEOUT");
      const currentNetwork = await submissionCall(() => haminn.permissions.status({ capability: 'network', scope: providerScope() }),
        5000, "模型网络授权状态查询超时。", "BRIDGE_TIMEOUT");
      networkGrant = currentNetwork.grant || 'unknown';
      if (networkGrant !== 'allow') throw new Error('模型服务网络权限尚未授予；没有操作屏幕。');
      setStatus('network', '已授权', 'good');
      if (!modelConnectionVerified) {
        setMessage(`网络授权已通过；正在调用 ${provider.displayName || provider.model}…`, 'wait');
        await testModelConnection();
      }

      await setBubbleState('托管', '#c18122');
      setMessage('正在启动 Haminn 后台 Worker；任务接管后即使离开此页面也会继续。', 'wait');
      const workerStart = await startWorkerForGoalSubmission();
      if (workerStart.state === 'waiting-user') throw new Error('后台运行授权尚未授予；任务未提交。');
      let workerStatus = workerStart;
      const workerReadyDeadline = Date.now() + 20_000;
      while (workerStatus.state !== 'running' && Date.now() < workerReadyDeadline) {
        if (workerStatus.state === 'failed' || workerStatus.state === 'stopped') {
          throw new Error(workerStatus.error || `后台 Worker 未能启动（${workerStatus.state}）。`);
        }
        await sleep(250);
        workerStatus = await submissionCall(() => haminn.workers.status(), 5000,
          '后台 Worker 状态查询超时。', 'WORKER_STATUS_TIMEOUT');
      }
      if (workerStatus.state !== 'running') throw new Error('后台 Worker 启动超过等待时限；任务未提交。');
      const eventId = await prepareDispatchEventId("goal.submit", { intent: instruction });
      const dispatched = await submissionCall(() => haminn.workers.dispatch({ event: { type: 'goal.submit', intent: instruction, eventId } }),
        5000, '后台任务投递超时。', 'WORKER_DISPATCH_TIMEOUT');
      if (!dispatched.accepted) throw new Error(`后台 Worker 未接收任务（${dispatched.state}）。`);
      await clearDispatchEventId("goal.submit", eventId);
      backgroundHandedOff = true;
      await finishTrace("handed-off");
      const result = { status: 'running', summary: '任务已交给 Haminn 后台 Worker。你可以离开页面；暂停、继续或取消可在 ImHamster 任务卡片中操作。',
        goalIntent: instruction, workerState: workerStatus.state, acceptedAt: Date.now() };
      await saveLastResult(result);
      setMessage(result.summary, 'success');
      await setBubbleState('运行', '#20966c');
    } catch (error) {
      const summary = error.message || '模型或视觉操作失败；没有执行确认的后续动作。';
      await finishTrace("failed", error);
      const stepCount = activeTrace?.events.filter((event) => event.phase === "step-start").length || 0;
      await saveLastResult({ status: 'blocked', summary, steps: stepCount || null,
        traceSummary: activeTrace?.summary || "", finishedAt: Date.now() });
      setMessage(summary, 'error');
      await setBubbleState('!', '#c94d53');
    } finally {
      submissionDeadlineAt = 0;
      operationRunning = false;
      updateControls();
    }
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function remainingSubmissionMs() {
    return submissionDeadlineAt > 0 ? Math.max(0, submissionDeadlineAt - Date.now()) : Number.POSITIVE_INFINITY;
  }

  function assertSubmissionTime() {
    if (submissionDeadlineAt <= 0 || Date.now() < submissionDeadlineAt) return;
    const error = new Error(SUBMISSION_TIMEOUT_MESSAGE);
    error.code = "SUBMISSION_TIMEOUT";
    throw error;
  }

  function submissionCall(invoke, maxMs, messageText, code) {
    const remaining = remainingSubmissionMs();
    if (remaining <= 0) {
      const error = new Error(SUBMISSION_TIMEOUT_MESSAGE);
      error.code = "SUBMISSION_TIMEOUT";
      return Promise.reject(error);
    }
    const deadlineLimited = remaining <= maxMs;
    const promise = typeof invoke === "function" ? invoke() : invoke;
    return withTimeout(promise, Math.min(maxMs, remaining), deadlineLimited ? SUBMISSION_TIMEOUT_MESSAGE : messageText,
      deadlineLimited ? "SUBMISSION_TIMEOUT" : code);
  }

  setupButton.addEventListener("click", continueSetup);
  workerJournalDetails?.addEventListener("toggle", () => {
    if (workerJournalDetails.open) void loadWorkerJournal();
  });
  workerPauseButton?.addEventListener("click", () => controlWorker("pause"));
  workerResumeButton?.addEventListener("click", () => controlWorker("resume"));
  workerCancelButton?.addEventListener("click", () => controlWorker("cancel"));
  workerEventTasks?.addEventListener("click", (event) => {
    const button = event.target?.closest?.("button[data-event-task-command]");
    if (button && workerEventTasks.contains(button)) void handleEventTaskControl(button);
  });
  consent.addEventListener("change", async () => {
    updateControls();
    if (!window.haminn?.isReady) return;
    try {
      await haminn.data.put({ collection: "screen-interaction", key: "consent-v2", value: consent.checked });
      if (!consent.checked && status?.hasOverlay && status.serviceConnected && status.authorization?.grant === "allow") {
        await haminn.overlay.remove();
      }
      await refreshStatus();
      if (consent.checked) setMessage("同意已保存。点下方按钮完成设置。", "success");
      else setMessage("同意已取消，ImHamster 悬浮球已关闭。", "wait");
    } catch (error) {
      setMessage(error.message || "无法保存知情同意状态。", "error");
    }
  });

  window.haminn?.on("overlay.clicked", runFromOverlay);

  memoryDetails?.addEventListener("toggle", () => {
    if (memoryDetails.open && !memoryLoaded) void loadMemoryPage();
  });
  memoryRefreshButton?.addEventListener("click", () => { void loadMemoryPage(); });
  memoryLoadMoreButton?.addEventListener("click", () => { void loadMemoryPage({ append: true }); });
  memoryList?.addEventListener("click", event => {
    const button = event.target?.closest?.("button[data-memory-action]");
    if (button) void handleMemoryAction(button);
  });

  window.addEventListener("pagehide", () => {
    if (!operationRunning || backgroundHandedOff) return;
    const stepCount = activeTrace?.events.filter((event) => event.phase === "step-start").length || 0;
    if (activeTrace) {
      activeTrace.finishedAt = Date.now();
      activeTrace.status = "interrupted";
      activeTrace.error = "PAGE_HIDDEN";
      activeTrace.summary = traceSummary();
      void recordTrace({ phase: "page-hidden", status: "interrupted" });
      void saveLastResult({ status: "interrupted", summary: "ImHamster 页面已退出，本次执行已中断。",
        steps: stepCount || null, traceSummary: activeTrace.summary, finishedAt: activeTrace.finishedAt });
    }
    void setBubbleState("停", "#c94d53");
  });

  async function onReady() {
    if (ready) return;
    ready = true;
    if (memoryRefreshButton) memoryRefreshButton.disabled = false;
    try {
      const consentRecord = await haminn.data.get({ collection: "screen-interaction", key: "consent-v2" });
      consent.checked = consentRecord?.value === true;
      try {
        await loadProviderConfig();
        const modelCheck = await haminn.data.get({ collection: "screen-interaction", key: "model-check" }).catch(() => null);
        if (modelCheck?.value?.kind === "screen-vision-v1" && modelCheck.value.model === provider.model && modelCheck.value.baseUrl === provider.baseUrl &&
            Number.isFinite(modelCheck.value.checkedAt) && Date.now() - modelCheck.value.checkedAt < 5 * 60_000) {
          modelConnectionVerified = true;
        }
        setStatus("model", provider.model, "good");
      } catch (error) {
        provider = null;
        setStatus("model", "配置不可用", "bad");
        setMessage(error.message || "模型配置不可用。", "error");
      }
      const previous = await haminn.data.get({ collection: "screen-interaction", key: "last-run" });
      if (previous?.value?.summary) {
        lastResult = previous.value;
        $("#last-result").textContent = previous.value.traceSummary
          ? `${previous.value.summary} · ${previous.value.traceSummary}` : previous.value.summary;
      }
      const hasBackgroundWorkerResult = Boolean(previous?.value?.goalIntent);
      const oldTrace = await haminn.data.get({ collection: "screen-interaction", key: "run-trace" }).catch(() => null);
      const traceLine = $("#run-trace");
      if (hasBackgroundWorkerResult && traceLine) traceLine.hidden = true;
      if (traceLine && !hasBackgroundWorkerResult && oldTrace?.value?.kind === "screen-task" && Array.isArray(oldTrace.value.events) && oldTrace.value.events.length) {
        traceLine.hidden = false;
        const trace = oldTrace.value;
        const summary = traceSummary(trace);
        trace.summary = summary;
        await haminn.data.put({ collection: "screen-interaction", key: "run-trace", value: trace }).catch(() => {});
        const rounds = new Set(trace.events.map((event) => event.step).filter(Number.isFinite)).size;
        const lastPhase = trace.events[trace.events.length - 1]?.phase || "无事件";
        const state = trace.status || "中断或未完成";
        traceLine.textContent = `运行轨迹（${state}）：${summary || `${rounds} 轮，最后阶段 ${lastPhase}`}。`;
      } else if (traceLine && previous?.value?.summary && /timeout/i.test(previous.value.summary)) {
        traceLine.hidden = false;
        traceLine.textContent = "这次超时没有保存逐步记录，无法还原旧版各步操作；后续运行会记录截图轮次、模型结果和 Bridge 动作状态。";
      }
      const priorComparison = await haminn.data.get({ collection: "screen-interaction", key: "provider-comparison" }).catch(() => null);
      if (!modelConnectionVerified && priorComparison?.value?.selectedModel === (provider?.displayName || provider?.model) &&
          Number.isFinite(priorComparison.value.finishedAt) && Date.now() - priorComparison.value.finishedAt < 15 * 60_000 &&
          priorComparison.value.providers?.some((item) => item.status === "passed")) {
        modelConnectionVerified = true;
      }
      updateControls();
      await refreshWorkerPanel();
      await refreshStatus();
      if (traceLine && !hasBackgroundWorkerResult && oldTrace?.value?.kind === "screen-task" && Array.isArray(oldTrace.value.events) && oldTrace.value.events.length) {
        const trace = oldTrace.value;
        const lastEvent = trace.events[trace.events.length - 1];
        if (trace.status === "completed") {
          await setBubbleState("✓", "#20966c");
          if (previous?.value?.summary) setMessage(previous.value.summary, "success");
        } else {
          await setBubbleState(trace.status === "failed" ? "!" : "停", "#c94d53");
          const pendingAction = lastEvent?.phase === "bridge-action" && lastEvent.result === "started";
          const detail = pendingAction
            ? `上次任务停在第 ${lastEvent.step} 轮：${lastEvent.actionType} 已发起，但 Bridge 没有回执；结果未确认。`
            : previous?.value?.summary || "上次屏幕任务未完成，请查看运行轨迹。";
          setMessage(detail, "error");
        }
      }
    } catch (error) {
      setMessage(error.message || "无法读取本 happ 配置。", "error");
    }
  }

  addEventListener("haminnready", onReady);
  setInterval(() => { if (ready && !document.hidden) refreshWorkerPanel(); }, 10_000);
  addEventListener("pageshow", () => { if (ready) refreshStatus(); });
  addEventListener("focus", () => { if (ready) refreshStatus(); });
  document.addEventListener("visibilitychange", () => { if (ready && !document.hidden) refreshStatus(); });
  if (window.haminn?.isReady) onReady();
})();
