export function prepareMemoryEdit(current, contentInput, objectRefsInput, updatedAt = Date.now()) {
  const content = typeof contentInput === "string" ? contentInput.trim() : "";
  const objectRefs = [...new Set(String(objectRefsInput || "").split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  if (!content || content.length > 800 || !objectRefs.length || objectRefs.length > 8 || objectRefs.some(value => value.length > 120)) {
    throw new Error("请填写 1–800 字记忆内容，并设置 1–8 个不超过 120 字的对象范围。");
  }
  return { ...current, content, objectRefs, revision: Math.max(1, Number(current?.revision) || 1) + 1, updatedAt };
}

export function mountMemoryPanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#memory-details");
  const notice = $("#memory-notice");
  const list = $("#memory-list");
  const refreshButton = $("#memory-refresh");
  const loadMoreButton = $("#memory-load-more");
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
    element.dataset.memoryAction = action;
    element.dataset.memoryKey = key;
    element.disabled = loading;
    return element;
  }

  function render() {
    if (!list) return;
    list.replaceChildren();
    for (const record of records) {
      const value = record?.value;
      if (!record?.key || value?.type !== "memory") continue;
      const entry = root.createElement("article");
      entry.className = "memory-entry";
      const title = root.createElement("p");
      title.className = "memory-entry-title";
      title.textContent = (Array.isArray(value.objectRefs) ? value.objectRefs : []).join("、") || "未标注对象";
      entry.append(title);
      const meta = root.createElement("p");
      meta.className = "memory-entry-meta";
      const kind = value.kind === "episode" ? "经历" : "事实";
      const inference = value.inference === "inferred" ? "推断" : "观察记录";
      const observedAt = Number(value.observedAt);
      const date = Number.isFinite(observedAt) && observedAt > 0 ? new Date(observedAt).toLocaleString() : "时间未知";
      meta.textContent = kind + " · " + inference + " · 来源 " + (Array.isArray(value.sourceRefs) ? value.sourceRefs.length : 0) + " 条 · " + date;
      entry.append(meta);

      if (editingKey === record.key) {
        const content = root.createElement("textarea");
        content.className = "memory-entry-editor";
        content.maxLength = 800;
        content.dataset.memoryContent = "true";
        content.setAttribute("aria-label", "记忆内容");
        content.value = String(value.content || "");
        const objects = root.createElement("input");
        objects.className = "memory-entry-objects";
        objects.type = "text";
        objects.maxLength = 1000;
        objects.dataset.memoryObjects = "true";
        objects.setAttribute("aria-label", "对象范围，使用逗号分隔");
        objects.value = (Array.isArray(value.objectRefs) ? value.objectRefs : []).join(", ");
        const fields = root.createElement("div");
        fields.append(content, objects);
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("保存修订", "save", record.key), button("取消", "cancel-edit", record.key));
        entry.append(fields, actions);
      } else {
        const content = root.createElement("p");
        content.className = "memory-entry-content";
        content.textContent = String(value.content || "");
        entry.append(content);
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("修订", "edit", record.key), button("删除", "delete", record.key, "button danger"));
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
    setNotice(append ? "正在读取更多记忆…" : "正在读取本机记忆…");
    try {
      const page = await bridge.data.scan({ collection: "knowledge", prefix: "memory:", limit: 100,
        ...(append && nextAfterKey ? { afterKey: nextAfterKey } : {}) });
      const incoming = Array.isArray(page?.items) ? page.items.filter(item => item?.value?.type === "memory") : [];
      const known = new Set(records.map(item => item.key));
      for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
      nextAfterKey = page?.nextAfterKey || null;
      loaded = true;
      const tail = nextAfterKey ? "；可继续加载" : "";
      setNotice(records.length ? "已读取 " + records.length + " 条记忆" + tail + "。" : "当前没有已保存的记忆。");
      render();
    } catch (error) {
      setNotice("读取记忆失败：" + String(error?.message || error).slice(0, 240), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      render();
    }
  }

  async function handleAction(element) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    const key = element.dataset.memoryKey || "";
    const action = element.dataset.memoryAction || "";
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
      const entry = element.closest(".memory-entry");
      let value;
      try {
        value = prepareMemoryEdit(record.value, entry?.querySelector("[data-memory-content]")?.value || "",
          entry?.querySelector("[data-memory-objects]")?.value || "");
      } catch (error) {
        setNotice(String(error?.message || error), "error");
        return;
      }
      loading = true;
      render();
      try {
        const updated = await bridge.data.put({ collection: "knowledge", key, value, expectedRevision: record.revision });
        record.value = value;
        record.revision = updated?.revision || record.revision;
        editingKey = "";
        setNotice("记忆已修订并保存。", "success");
      } catch (error) {
        setNotice("保存失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
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
        await bridge.data.delete({ collection: "knowledge", key, expectedRevision: record.revision });
        records = records.filter(item => item.key !== key);
        deleteConfirmKey = "";
        setNotice("记忆已删除。", "success");
      } catch (error) {
        setNotice("删除失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        loading = false;
        if (refreshButton) refreshButton.disabled = !ready;
        render();
      }
    }
  }

  details?.addEventListener("toggle", () => {
    if (details.open && ready && !loaded) void loadPage();
  });
  refreshButton?.addEventListener("click", () => { void loadPage(); });
  loadMoreButton?.addEventListener("click", () => { void loadPage({ append: true }); });
  list?.addEventListener("click", event => {
    const element = event.target?.closest?.("button[data-memory-action]");
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
