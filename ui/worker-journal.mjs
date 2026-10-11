const PAGE_SIZE = 100;
const MAX_INITIAL_PAGES = 10;
const MAX_INCREMENTAL_PAGES = 3;
const MAX_VISIBLE_EVENTS = 500;
const MAX_EVENT_CHARS = 4000;
const POLL_INTERVAL_MS = 3000;

export function formatWorkerJournal(records, { hasMore = false } = {}) {
  const events = Array.isArray(records) ? records : [];
  const lines = events.map(({ value } = {}) => {
    const entry = value && typeof value === "object" ? value : {};
    const at = Number(entry.at);
    const time = Number.isFinite(at) ? new Date(at).toLocaleTimeString() : "--:--:--";
    const serialized = JSON.stringify(entry);
    const detail = serialized.length > MAX_EVENT_CHARS
      ? `${serialized.slice(0, MAX_EVENT_CHARS)}…[详情截断]` : serialized;
    return `${time} #${entry.step || 0} ${entry.phase || "event"} ${detail}`;
  });
  const notice = hasMore ? `读取到 ${events.length} 条，还有事件待加载。`
    : `共 ${events.length} 条事件。`;
  return lines.length ? `${notice}\n${lines.join("\n")}` : "该 OST 尚无事件记录。";
}

export function mountWorkerJournal({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#worker-journal-details");
  const refreshButton = $("#worker-journal-refresh");
  const output = $("#worker-journal-events");
  let goalId = "";
  let afterKey = null;
  let records = [];
  let ready = false;
  let loaded = false;
  let loading = false;
  let hasMore = false;
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer !== null) globalThis.clearInterval(pollTimer);
    pollTimer = null;
  }

  function render() {
    if (!output) return;
    const remaining = Number(output.scrollHeight) - Number(output.scrollTop) - Number(output.clientHeight);
    const followOutput = !Number.isFinite(remaining) || remaining < 48;
    output.textContent = formatWorkerJournal(records, { hasMore });
    if (followOutput) output.scrollTop = output.scrollHeight;
  }

  async function loadJournal({ reset = false } = {}) {
    const bridge = host();
    if (!ready || !goalId || loading || !bridge?.isReady || !output) return;
    if (reset) {
      afterKey = null;
      records = [];
      hasMore = false;
      loaded = false;
    }
    const currentGoalId = goalId;
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    if (!loaded) output.textContent = "正在读取后台事件记录…";
    try {
      const pageLimit = loaded ? MAX_INCREMENTAL_PAGES : MAX_INITIAL_PAGES;
      const known = new Set(records.map(item => item?.key).filter(Boolean));
      let pages = 0;
      do {
        const page = await bridge.data.scan({ collection: "agent-events", prefix: `e:${currentGoalId}:`, limit: PAGE_SIZE,
          ...(afterKey ? { afterKey } : {}) });
        if (currentGoalId !== goalId) return;
        const items = Array.isArray(page?.items) ? page.items : [];
        for (const item of items) {
          if (item?.key && !known.has(item.key)) {
            records.push(item);
            known.add(item.key);
          }
        }
        if (items.length) afterKey = page?.nextAfterKey || items.at(-1)?.key || afterKey;
        else if (page?.nextAfterKey) afterKey = page.nextAfterKey;
        hasMore = Boolean(page?.nextAfterKey);
        pages += 1;
        if (!page?.nextAfterKey || currentGoalId !== goalId || !details?.open) break;
      } while (pages < pageLimit);
      if (records.length > MAX_VISIBLE_EVENTS) records = records.slice(-MAX_VISIBLE_EVENTS);
      if (currentGoalId !== goalId) return;
      loaded = true;
      render();
    } catch (error) {
      if (currentGoalId === goalId && output) {
        output.textContent = `事件记录读取失败：${String(error?.message || error).slice(0, 300)}`;
      }
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
    }
  }

  function syncPolling() {
    if (!ready || !goalId || !details?.open) {
      stopPolling();
      return;
    }
    if (pollTimer === null) {
      void loadJournal();
      pollTimer = globalThis.setInterval(() => { void loadJournal(); }, POLL_INTERVAL_MS);
    }
  }

  details?.addEventListener("toggle", syncPolling);
  refreshButton?.addEventListener("click", () => { void loadJournal(); });
  globalThis.window?.addEventListener("pagehide", stopPolling);

  return {
    setGoalId(value) {
      const nextGoalId = typeof value === "string" ? value : "";
      if (nextGoalId === goalId) return;
      stopPolling();
      goalId = nextGoalId;
      afterKey = null;
      records = [];
      hasMore = false;
      loaded = false;
      if (details) {
        details.open = false;
        details.hidden = !goalId;
      }
      if (output) output.textContent = "展开后读取事件记录";
    },
    setReady(value) {
      ready = Boolean(value);
      if (refreshButton) refreshButton.disabled = !ready;
      syncPolling();
    },
    refresh: () => loadJournal({ reset: true }),
  };
}
