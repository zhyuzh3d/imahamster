const FIELDS = [
  { key: "title", label: "名称", maxLength: 120 },
  { key: "condition", label: "适用情境", maxLength: 240 },
  { key: "guidance", label: "行为建议", maxLength: 500 },
  { key: "evidence", label: "来源依据", maxLength: 300 },
];

export function prepareBehaviorPatternEdit(current, input, updatedAt = Date.now()) {
  const value = {};
  for (const field of FIELDS) {
    const text = typeof input?.[field.key] === "string" ? input[field.key].trim() : "";
    if (!text || text.length > field.maxLength) throw new Error(`${field.label}不能为空，且不能超过 ${field.maxLength} 字。`);
    value[field.key] = text;
  }
  return { ...current, ...value, revision: Math.max(1, Number(current?.revision) || 1) + 1, updatedAt };
}

export function prepareBehaviorPatternStatus(current, state, updatedAt = Date.now()) {
  if (!current || !["active", "disabled"].includes(state)) throw new TypeError("BP 状态无效");
  const next = { ...current, state, revision: Math.max(1, Number(current.revision) || 1) + 1, updatedAt };
  if (state === "disabled") next.disabledAt = updatedAt;
  else delete next.disabledAt;
  return next;
}

export function mountBehaviorPatternsPanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#bp-details");
  const notice = $("#bp-notice");
  const list = $("#bp-list");
  const refreshButton = $("#bp-refresh");
  const loadMoreButton = $("#bp-load-more");
  let records = [];
  let nextAfterKey = null;
  let loading = false;
  let loaded = false;
  let editingKey = "";
  let deleteConfirmKey = "";
  let ready = false;

  function setNotice(text, tone = "") {
    if (!notice) return;
    notice.textContent = text;
    notice.dataset.tone = tone;
  }

  function button(label, action, key, className = "button secondary") {
    const element = root.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.dataset.bpAction = action;
    element.dataset.bpKey = key;
    element.disabled = loading;
    return element;
  }

  function fieldInput(field, value) {
    const label = root.createElement("label");
    label.className = "bp-field";
    const caption = root.createElement("span");
    caption.className = "bp-field-label";
    caption.textContent = field.label;
    const input = root.createElement("textarea");
    input.className = "bp-editor";
    input.maxLength = field.maxLength;
    input.dataset.bpField = field.key;
    input.setAttribute("aria-label", field.label);
    input.value = String(value || "");
    label.append(caption, input);
    return label;
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    for (const record of records) {
      const value = record?.value;
      if (!record?.key || value?.type !== "behavior-pattern") continue;
      const entry = root.createElement("article");
      entry.className = "bp-entry";
      const title = root.createElement("p");
      title.className = "bp-entry-title";
      title.textContent = String(value.title || "未命名行为模式");
      entry.append(title);
      const meta = root.createElement("p");
      meta.className = "bp-entry-meta";
      const at = Number(value.updatedAt || value.createdAt);
      meta.textContent = (value.state === "active" ? "启用" : "已停用") + " · " +
        (Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : "时间未知");
      entry.append(meta);

      if (editingKey === record.key) {
        const fields = root.createElement("div");
        fields.className = "bp-fields";
        for (const field of FIELDS) fields.append(fieldInput(field, value[field.key]));
        const actions = root.createElement("div");
        actions.className = "bp-entry-actions";
        actions.append(button("保存修订", "save", record.key), button("取消", "cancel-edit", record.key));
        entry.append(fields, actions);
      } else {
        for (const field of FIELDS.slice(1)) {
          const text = root.createElement("p");
          text.className = field.key === "evidence" ? "bp-entry-evidence" : "bp-entry-text";
          const prefix = root.createElement("strong");
          prefix.textContent = field.label + "：";
          text.append(prefix, root.createTextNode(String(value[field.key] || "")));
          entry.append(text);
        }
        const actions = root.createElement("div");
        actions.className = "bp-entry-actions";
        actions.append(button("修订", "edit", record.key));
        if (value.state === "active") actions.append(button("停用", "disable", record.key));
        else actions.append(button("启用", "enable", record.key));
        actions.append(button("删除", "delete", record.key, "button danger"));
        if (deleteConfirmKey === record.key) {
          actions.append(button("确认删除", "confirm-delete", record.key, "button danger"), button("取消", "cancel-delete", record.key));
        }
        entry.append(actions);
      }
      list.append(entry);
    }
    if (loadMoreButton) {
      loadMoreButton.hidden = !nextAfterKey;
      loadMoreButton.disabled = loading || !ready;
    }
  }

  async function loadPage({ append = false } = {}) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    if (!append) {
      records = [];
      nextAfterKey = null;
      loaded = false;
      editingKey = "";
      deleteConfirmKey = "";
      if (list) list.replaceChildren();
    }
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    if (loadMoreButton) loadMoreButton.disabled = true;
    setNotice(append ? "正在读取更多行为模式…" : "正在读取行为模式…");
    try {
      const page = await bridge.data.scan({ collection: "self-model", prefix: "bp:", limit: 100,
        ...(append && nextAfterKey ? { afterKey: nextAfterKey } : {}) });
      const incoming = Array.isArray(page?.items) ? page.items.filter(item => item?.value?.type === "behavior-pattern") : [];
      const known = new Set(records.map(item => item.key));
      for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
      nextAfterKey = page?.nextAfterKey || null;
      loaded = true;
      setNotice(records.length ? "已读取 " + records.length + " 条行为模式" + (nextAfterKey ? "；可继续加载。" : "。") : "当前没有已保存的行为模式。");
      render();
    } catch (error) {
      setNotice("读取行为模式失败：" + String(error?.message || error).slice(0, 240), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      render();
    }
  }

  async function handleAction(element) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    const key = element.dataset.bpKey || "";
    const action = element.dataset.bpAction || "";
    const record = records.find(item => item.key === key);
    if (!record) return;
    if (action === "edit") {
      editingKey = key;
      deleteConfirmKey = "";
      render();
      return;
    }
    if (action === "cancel-edit") {
      editingKey = "";
      render();
      return;
    }
    if (action === "delete") {
      deleteConfirmKey = key;
      editingKey = "";
      render();
      return;
    }
    if (action === "cancel-delete") {
      deleteConfirmKey = "";
      render();
      return;
    }
    if (action === "save") {
      const entry = element.closest(".bp-entry");
      const input = Object.fromEntries([...entry.querySelectorAll("[data-bp-field]")].map(field => [field.dataset.bpField, field.value]));
      let value;
      try { value = prepareBehaviorPatternEdit(record.value, input); }
      catch (error) { setNotice(String(error?.message || error), "error"); return; }
      loading = true;
      render();
      try {
        const result = await bridge.data.put({ collection: "self-model", key, value, expectedRevision: record.revision });
        record.value = value;
        record.revision = result?.revision || record.revision;
        editingKey = "";
        setNotice("行为模式已修订并保存。", "success");
      } catch (error) {
        setNotice("保存失败；记录可能已更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        loading = false;
        if (refreshButton) refreshButton.disabled = !ready;
        render();
      }
      return;
    }
    if (action === "disable" || action === "enable") {
      const value = prepareBehaviorPatternStatus(record.value, action === "disable" ? "disabled" : "active");
      loading = true;
      render();
      try {
        const result = await bridge.data.put({ collection: "self-model", key, value, expectedRevision: record.revision });
        record.value = value;
        record.revision = result?.revision || record.revision;
        setNotice(value.state === "active" ? "行为模式已启用。" : "行为模式已停用。", "success");
      } catch (error) {
        setNotice("状态更新失败；记录可能已更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        loading = false;
        if (refreshButton) refreshButton.disabled = !ready;
        render();
      }
      return;
    }
    if (action === "confirm-delete") {
      loading = true;
      render();
      try {
        await bridge.data.delete({ collection: "self-model", key, expectedRevision: record.revision });
        records = records.filter(item => item.key !== key);
        deleteConfirmKey = "";
        setNotice("行为模式已删除。", "success");
      } catch (error) {
        setNotice("删除失败；记录可能已更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        loading = false;
        if (refreshButton) refreshButton.disabled = !ready;
        render();
      }
    }
  }

  details?.addEventListener("toggle", () => { if (details.open && ready && !loaded) void loadPage(); });
  refreshButton?.addEventListener("click", () => { void loadPage(); });
  loadMoreButton?.addEventListener("click", () => { void loadPage({ append: true }); });
  list?.addEventListener("click", event => {
    const element = event.target?.closest?.("button[data-bp-action]");
    if (element && list.contains(element)) void handleAction(element);
  });

  return {
    setReady(value) {
      ready = Boolean(value);
      if (refreshButton) refreshButton.disabled = !ready;
      if (ready && details?.open && !loaded) void loadPage();
      render();
    },
    refresh: () => loadPage(),
  };
}
