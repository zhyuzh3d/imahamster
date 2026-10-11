import { isRegisteredTool } from "../agent/te/catalog.mjs";

export function prepareMemoryEdit(current, contentInput, objectRefsInput, updatedAt = Date.now()) {
  const content = typeof contentInput === "string" ? contentInput.trim() : "";
  const objectRefs = [...new Set(String(objectRefsInput || "").split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  if (!content || content.length > 800 || !objectRefs.length || objectRefs.length > 8 || objectRefs.some(value => value.length > 120)) {
    throw new Error("请填写 1–800 字记忆内容，并设置 1–8 个不超过 120 字的对象范围。");
  }
  return { ...current, content, objectRefs, revision: Math.max(1, Number(current?.revision) || 1) + 1, updatedAt };
}

export function prepareExperienceEdit(current, {
  title: titleInput, situation: situationInput, approach: approachInput,
  successEvidence: evidenceInput, toolRefs: toolRefsInput,
} = {}, updatedAt = Date.now()) {
  const title = typeof titleInput === "string" ? titleInput.trim() : "";
  const situation = typeof situationInput === "string" ? situationInput.trim() : "";
  const approach = typeof approachInput === "string" ? approachInput.trim() : "";
  const successEvidence = typeof evidenceInput === "string" ? evidenceInput.trim() : "";
  const toolRefs = [...new Set(String(toolRefsInput || "").split(/[,，\n]/).map(value => value.trim()).filter(Boolean))];
  if (!title || title.length > 120 || !situation || situation.length > 800 || !approach || approach.length > 800 ||
      !successEvidence || successEvidence.length > 800 || toolRefs.length > 8 || toolRefs.some(name => !isRegisteredTool(name))) {
    throw new Error("经验需要标题、情境、做法和结果依据；各字段需符合长度限制，工具只能引用已注册工具。");
  }
  const currentRevision = Number(current?.revision);
  const revision = Number.isSafeInteger(currentRevision) && currentRevision > 0 ? currentRevision : 0;
  return {
    ...current,
    type: "experience",
    state: current?.state === "inactive" ? "inactive" : "active",
    title, situation, approach, successEvidence, toolRefs,
    revision: revision + 1,
    updatedAt,
  };
}

export function mountMemoryPanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#memory-details");
  const notice = $("#memory-notice");
  const list = $("#memory-list");
  const refreshButton = $("#memory-refresh");
  const loadMoreButton = $("#memory-load-more");
  let records = [];
  let nextMemoryAfterKey = null;
  let nextExperienceAfterKey = null;
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
      if (!record?.key || !["memory", "experience"].includes(value?.type)) continue;
      const entry = root.createElement("article");
      entry.className = "memory-entry";
      const title = root.createElement("p");
      title.className = "memory-entry-title";
      title.textContent = value.type === "experience"
        ? String(value.title || "未命名经验")
        : (Array.isArray(value.objectRefs) ? value.objectRefs : []).join("、") || "未标注对象";
      entry.append(title);
      const meta = root.createElement("p");
      meta.className = "memory-entry-meta";
      if (value.type === "experience") {
        const createdAt = Number(value.updatedAt || value.createdAt);
        const date = Number.isFinite(createdAt) && createdAt > 0 ? new Date(createdAt).toLocaleString() : "时间未知";
        meta.textContent = "可复用经验 · 工具 " + (Array.isArray(value.toolRefs) ? value.toolRefs.length : 0) + " 项 · " + date;
      } else {
        const kind = value.kind === "episode" ? "经历" : "事实";
        const inference = value.inference === "inferred" ? "推断" : "观察记录";
        const observedAt = Number(value.observedAt);
        const date = Number.isFinite(observedAt) && observedAt > 0 ? new Date(observedAt).toLocaleString() : "时间未知";
        meta.textContent = kind + " · " + inference + " · 来源 " + (Array.isArray(value.sourceRefs) ? value.sourceRefs.length : 0) + " 条 · " + date;
      }
      entry.append(meta);

      if (editingKey === record.key) {
        const fields = root.createElement("div");
        fields.className = "memory-entry-fields";
        if (value.type === "experience") {
          const input = (field, label, current, maxLength) => {
            const wrapper = root.createElement("label");
            wrapper.className = "memory-entry-field";
            wrapper.textContent = label;
            const control = root.createElement(field === "title" || field === "toolRefs" ? "input" : "textarea");
            control.className = "memory-entry-editor";
            control.maxLength = maxLength;
            if (control.tagName === "INPUT") control.type = "text";
            control.dataset.memoryField = field;
            control.value = String(current || "");
            wrapper.append(control);
            return wrapper;
          };
          fields.append(
            input("title", "标题", value.title, 120),
            input("situation", "适用情境", value.situation, 800),
            input("approach", "处理做法", value.approach, 800),
            input("successEvidence", "结果依据", value.successEvidence, 800),
            input("toolRefs", "已注册工具（逗号分隔）", (Array.isArray(value.toolRefs) ? value.toolRefs : []).join(", "), 800),
          );
        } else {
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
          fields.append(content, objects);
        }
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
      loadMoreButton.hidden = !nextMemoryAfterKey && !nextExperienceAfterKey;
      loadMoreButton.disabled = loading || !ready;
    }
  }

  async function loadPage({ append = false } = {}) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    if (!append) {
      records = [];
      nextMemoryAfterKey = null;
      nextExperienceAfterKey = null;
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
      const [memoryPage, experiencePage] = await Promise.all([
        !append || nextMemoryAfterKey
          ? bridge.data.scan({ collection: "knowledge", prefix: "memory:", limit: 100,
            ...(append && nextMemoryAfterKey ? { afterKey: nextMemoryAfterKey } : {}) })
          : Promise.resolve({ items: [] }),
        !append || nextExperienceAfterKey
          ? bridge.data.scan({ collection: "knowledge", prefix: "experience:", limit: 100,
            ...(append && nextExperienceAfterKey ? { afterKey: nextExperienceAfterKey } : {}) })
          : Promise.resolve({ items: [] }),
      ]);
      const incoming = [
        ...(Array.isArray(memoryPage?.items) ? memoryPage.items.filter(item => item?.value?.type === "memory") : []),
        ...(Array.isArray(experiencePage?.items) ? experiencePage.items.filter(item => item?.value?.type === "experience") : []),
      ];
      const known = new Set(records.map(item => item.key));
      for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
      nextMemoryAfterKey = memoryPage?.nextAfterKey || null;
      nextExperienceAfterKey = experiencePage?.nextAfterKey || null;
      records.sort((left, right) => {
        const leftAt = Number(left.value?.updatedAt || left.value?.observedAt || left.value?.createdAt) || 0;
        const rightAt = Number(right.value?.updatedAt || right.value?.observedAt || right.value?.createdAt) || 0;
        return rightAt - leftAt || String(left.key).localeCompare(String(right.key));
      });
      loaded = true;
      const tail = nextMemoryAfterKey || nextExperienceAfterKey ? "；可继续加载" : "";
      setNotice(records.length ? "已读取 " + records.length + " 条 Memory（含事实、经历和操作经验）" + tail + "。" : "当前没有已保存的 Memory。");
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
        if (record.value.type === "experience") {
          const field = name => entry?.querySelector(`[data-memory-field="${name}"]`)?.value || "";
          value = prepareExperienceEdit(record.value, {
            title: field("title"), situation: field("situation"), approach: field("approach"),
            successEvidence: field("successEvidence"), toolRefs: field("toolRefs"),
          });
        } else {
          value = prepareMemoryEdit(record.value, entry?.querySelector("[data-memory-content]")?.value || "",
            entry?.querySelector("[data-memory-objects]")?.value || "");
        }
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
