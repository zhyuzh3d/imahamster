import { TOOL_CATALOG } from "../agent/te/catalog.mjs";
import { normalizeToolCandidateRecord, prepareToolCandidateEdit, prepareToolCandidateState } from "../agent/te/candidate.mjs";

export function mountToolPanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#tool-details");
  const notice = $("#tool-notice");
  const registered = $("#tool-registered-list");
  const candidates = $("#tool-candidate-list");
  const refreshButton = $("#tool-refresh");
  const loadMoreButton = $("#tool-load-more");
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

  function button(label, command, key = "", className = "button secondary") {
    const element = root.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.dataset.toolAction = command;
    element.dataset.toolKey = key;
    element.disabled = loading;
    return element;
  }

  function renderRegistered() {
    if (!registered) return;
    registered.replaceChildren();
    for (const tool of TOOL_CATALOG) {
      const item = root.createElement("li");
      const name = root.createElement("strong");
      name.textContent = tool.name;
      const kind = root.createElement("span");
      kind.textContent = tool.kind === "screen-observation" ? "可执行 · 观察" : "可执行 · 动作";
      item.append(name, kind);
      registered.append(item);
    }
  }

  function renderCandidates() {
    if (!candidates) return;
    candidates.replaceChildren();
    for (const record of records) {
      const value = normalizeToolCandidateRecord(record, { includeInactive: true });
      if (!record?.key || !value) continue;
      const entry = root.createElement("article");
      entry.className = "tool-candidate-entry";
      const title = root.createElement("p");
      title.className = "memory-entry-title";
      title.textContent = value.name;
      entry.append(title);
      const meta = root.createElement("p");
      meta.className = "memory-entry-meta";
      const sourceGoalId = record.value?.sourceGoalId;
      const source = typeof sourceGoalId === "string" ? " · 来源任务 " + sourceGoalId.slice(0, 48) : "";
      meta.textContent = (value.state === "inactive" ? "已停用候选" : "参考候选 · 不可直接执行") + source;
      entry.append(meta);

      if (editingKey === record.key) {
        const fields = root.createElement("div");
        fields.className = "memory-entry-fields";
        const field = (name, label, current, maxLength, multiline = false) => {
          const wrapper = root.createElement("label");
          wrapper.className = "memory-entry-field";
          wrapper.textContent = label;
          const control = root.createElement(multiline ? "textarea" : "input");
          control.className = "tool-candidate-editor";
          control.maxLength = maxLength;
          if (!multiline) control.type = "text";
          control.dataset.toolField = name;
          control.value = String(current || "");
          wrapper.append(control);
          return wrapper;
        };
        fields.append(
          field("name", "候选名称", value.name, 80),
          field("description", "适用说明", value.description, 600, true),
          field("toolRefs", "已注册工具（逗号分隔）", (value.toolRefs || []).join(", "), 500),
        );
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("保存修订", "save", record.key), button("取消", "cancel-edit", record.key));
        entry.append(fields, actions);
      } else {
        const description = root.createElement("p");
        description.className = "memory-entry-content";
        description.textContent = String(value.description || "");
        entry.append(description);
        const refs = root.createElement("p");
        refs.className = "tool-candidate-refs";
        refs.textContent = "参考工具：" + (Array.isArray(value.toolRefs) ? value.toolRefs.join("、") : "");
        entry.append(refs);
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("修订", "edit", record.key));
        actions.append(value.state === "inactive"
          ? button("恢复推荐", "activate", record.key)
          : button("停用候选", "deactivate", record.key));
        actions.append(button("删除", "delete", record.key, "button danger"));
        if (deleteConfirmKey === record.key) {
          actions.append(button("确认删除", "confirm-delete", record.key, "button danger"), button("取消", "cancel-delete", record.key));
        }
        entry.append(actions);
      }
      candidates.append(entry);
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
      if (candidates) candidates.replaceChildren();
    }
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    if (loadMoreButton) loadMoreButton.disabled = true;
    setNotice(append ? "正在读取更多候选流程…" : "正在读取候选流程…");
    try {
      const page = await bridge.data.scan({ collection: "knowledge", prefix: "tool-candidate:", limit: 100,
        ...(append && nextAfterKey ? { afterKey: nextAfterKey } : {}) });
      const incoming = Array.isArray(page?.items)
        ? page.items.filter(item => normalizeToolCandidateRecord(item, { includeInactive: true })) : [];
      const known = new Set(records.map(item => item.key));
      for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
      nextAfterKey = page?.nextAfterKey || null;
      loaded = true;
      setNotice(records.length
        ? `已读取 ${records.length} 条候选流程。它们只能供 LLM 参考；实际操作仍限于上方已注册工具。${nextAfterKey ? " 可继续加载。" : ""}`
        : "当前没有已保存的候选流程。");
      renderCandidates();
    } catch (error) {
      setNotice("读取候选流程失败：" + String(error?.message || error).slice(0, 240), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      renderCandidates();
    }
  }

  async function handleAction(element) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    const key = element.dataset.toolKey || "";
    const command = element.dataset.toolAction || "";
    const record = records.find(item => item.key === key);
    if (!record) return;
    if (command === "edit") {
      editingKey = key;
      deleteConfirmKey = "";
      renderCandidates();
      return;
    }
    if (command === "cancel-edit") {
      editingKey = "";
      renderCandidates();
      return;
    }
    if (command === "delete") {
      deleteConfirmKey = key;
      editingKey = "";
      renderCandidates();
      return;
    }
    if (command === "cancel-delete") {
      deleteConfirmKey = "";
      renderCandidates();
      return;
    }
    if (command === "save") {
      const entry = element.closest(".tool-candidate-entry");
      const field = name => entry?.querySelector(`[data-tool-field="${name}"]`)?.value || "";
      let value;
      try {
        value = prepareToolCandidateEdit(record.value, { name: field("name"), description: field("description"), toolRefs: field("toolRefs") });
      } catch (error) {
        setNotice(String(error?.message || error), "error");
        return;
      }
      const saved = await saveRecord(record, value, "候选流程已修订。");
      if (saved) editingKey = "";
      renderCandidates();
      return;
    }
    if (command === "deactivate" || command === "activate") {
      const state = command === "deactivate" ? "inactive" : "candidate";
      await saveRecord(record, prepareToolCandidateState(record.value, state), state === "candidate" ? "候选流程已恢复推荐。" : "候选流程已停用。", true);
      return;
    }
    if (command === "confirm-delete") {
      loading = true;
      renderCandidates();
      try {
        await bridge.data.delete({ collection: "knowledge", key, expectedRevision: record.revision });
        records = records.filter(item => item.key !== key);
        deleteConfirmKey = "";
        setNotice("候选流程已删除。", "success");
      } catch (error) {
        setNotice("删除失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
      } finally {
        loading = false;
        if (refreshButton) refreshButton.disabled = !ready;
        renderCandidates();
      }
    }
  }

  async function saveRecord(record, value, noticeText, clearEditing = false) {
    const bridge = host();
    let saved = false;
    loading = true;
    renderCandidates();
    try {
      const updated = await bridge.data.put({ collection: "knowledge", key: record.key, value,
        expectedRevision: record.revision });
      record.value = value;
      record.revision = updated?.revision || record.revision;
      if (clearEditing) editingKey = "";
      deleteConfirmKey = "";
      setNotice(noticeText, "success");
      saved = true;
    } catch (error) {
      setNotice("保存失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      renderCandidates();
    }
    return saved;
  }

  renderRegistered();
  details?.addEventListener("toggle", () => { if (details.open && ready && !loaded) void loadPage(); });
  refreshButton?.addEventListener("click", () => { void loadPage(); });
  loadMoreButton?.addEventListener("click", () => { void loadPage({ append: true }); });
  candidates?.addEventListener("click", event => {
    const element = event.target?.closest?.("button[data-tool-action]");
    if (element && candidates.contains(element)) void handleAction(element);
  });

  return {
    setReady(value) {
      ready = Boolean(value);
      if (refreshButton) refreshButton.disabled = !ready;
      if (ready && details?.open && !loaded) void loadPage();
      renderCandidates();
    },
    refresh: () => loadPage(),
  };
}
