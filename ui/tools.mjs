import { TOOL_CATALOG } from "../agent/te/catalog.mjs";
import { normalizeToolCandidateRecord, prepareToolCandidateEdit, prepareToolCandidateState } from "../agent/te/candidate.mjs";
import { normalizeToolRecipeRecord, prepareToolRecipeEdit, prepareToolRecipeState } from "../agent/te/recipe.mjs";

export function mountToolPanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#tool-details");
  const notice = $("#tool-notice");
  const registered = $("#tool-registered-list");
  const candidates = $("#tool-candidate-list");
  const recipes = $("#tool-recipe-list");
  const refreshButton = $("#tool-refresh");
  const loadMoreButton = $("#tool-load-more");
  let records = [];
  let nextAfterCandidateKey = null;
  let nextAfterRecipeKey = null;
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

  function renderRecipes() {
    if (!recipes) return;
    recipes.replaceChildren();
    for (const record of records) {
      const value = normalizeToolRecipeRecord(record, { includeInactive: true });
      if (!record?.key || !value) continue;
      const entry = root.createElement("article");
      entry.className = "tool-candidate-entry";
      const title = root.createElement("p");
      title.className = "memory-entry-title";
      title.textContent = value.name;
      entry.append(title);
      const meta = root.createElement("p");
      meta.className = "memory-entry-meta";
      meta.textContent = `${value.state === "inactive" ? "已停用配方" : "LLM 引导配方"} · ${value.steps.length} 步`;
      entry.append(meta);
      if (editingKey === record.key) {
        const fields = root.createElement("div");
        fields.className = "memory-entry-fields";
        const field = (name, label, current, maxLength) => {
          const wrapper = root.createElement("label");
          wrapper.className = "memory-entry-field";
          wrapper.textContent = label;
          const control = root.createElement("textarea");
          control.className = "tool-candidate-editor";
          control.maxLength = maxLength;
          control.dataset.toolField = name;
          control.value = String(current || "");
          wrapper.append(control);
          return wrapper;
        };
        fields.append(
          field("name", "配方名称", value.name, 80),
          field("purpose", "配方用途", value.purpose, 600),
          field("applicability", "适用条件", value.applicability, 400),
          field("steps", "有序步骤 JSON（2–8 步，仅限已注册工具）", JSON.stringify(value.steps, null, 2), 5000),
        );
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("保存修订", "save", record.key), button("取消", "cancel-edit", record.key));
        entry.append(fields, actions);
      } else {
        const purpose = root.createElement("p");
        purpose.className = "memory-entry-content";
        purpose.textContent = value.purpose + (value.applicability ? `（适用：${value.applicability}）` : "");
        entry.append(purpose);
        const list = root.createElement("ol");
        list.className = "tool-candidate-refs";
        for (const step of value.steps) {
          const item = root.createElement("li");
          item.textContent = `${step.toolRef}：${step.purpose}`;
          list.append(item);
        }
        entry.append(list);
        const actions = root.createElement("div");
        actions.className = "memory-entry-actions";
        actions.append(button("修订", "edit", record.key));
        actions.append(value.state === "inactive"
          ? button("启用配方", "activate", record.key)
          : button("停用配方", "deactivate", record.key));
        actions.append(button("删除", "delete", record.key, "button danger"));
        if (deleteConfirmKey === record.key) {
          actions.append(button("确认删除", "confirm-delete", record.key, "button danger"), button("取消", "cancel-delete", record.key));
        }
        entry.append(actions);
      }
      recipes.append(entry);
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
      loadMoreButton.hidden = !nextAfterCandidateKey && !nextAfterRecipeKey;
      loadMoreButton.disabled = loading || !ready;
    }
    renderRecipes();
  }

  async function loadPage({ append = false } = {}) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    if (!append) {
      records = [];
      nextAfterCandidateKey = null;
      nextAfterRecipeKey = null;
      loaded = false;
      editingKey = "";
      deleteConfirmKey = "";
      if (candidates) candidates.replaceChildren();
      if (recipes) recipes.replaceChildren();
    }
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    if (loadMoreButton) loadMoreButton.disabled = true;
    setNotice(append ? "正在读取更多工具条目…" : "正在读取本机工具条目…");
    try {
      if (!append || nextAfterCandidateKey) {
        const page = await bridge.data.scan({ collection: "knowledge", prefix: "tool-candidate:", limit: 100,
          ...(append && nextAfterCandidateKey ? { afterKey: nextAfterCandidateKey } : {}) });
        const incoming = Array.isArray(page?.items)
          ? page.items.filter(item => normalizeToolCandidateRecord(item, { includeInactive: true })) : [];
        const known = new Set(records.map(item => item.key));
        for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
        nextAfterCandidateKey = page?.nextAfterKey || null;
      }
      if (!append || nextAfterRecipeKey) {
        const page = await bridge.data.scan({ collection: "knowledge", prefix: "tool-recipe:", limit: 100,
          ...(append && nextAfterRecipeKey ? { afterKey: nextAfterRecipeKey } : {}) });
        const incoming = Array.isArray(page?.items)
          ? page.items.filter(item => normalizeToolRecipeRecord(item, { includeInactive: true })) : [];
        const known = new Set(records.map(item => item.key));
        for (const item of incoming) if (item?.key && !known.has(item.key)) records.push(item);
        nextAfterRecipeKey = page?.nextAfterKey || null;
      }
      loaded = true;
      setNotice(records.length
        ? `已读取 ${records.filter(item => item.value?.type === "tool-recipe").length} 条工具配方与 ${records.filter(item => item.value?.type === "tool-candidate").length} 条历史候选。配方由 LLM 按截图逐步判断；实际动作仍限于上方已注册工具。${nextAfterCandidateKey || nextAfterRecipeKey ? " 可继续加载。" : ""}`
        : "当前没有已保存的工具配方或历史候选。");
      renderCandidates();
    } catch (error) {
      setNotice("读取工具条目失败：" + String(error?.message || error).slice(0, 240), "error");
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
        value = record.value?.type === "tool-recipe"
          ? prepareToolRecipeEdit(record.value, { name: field("name"), purpose: field("purpose"), applicability: field("applicability"), steps: field("steps") })
          : prepareToolCandidateEdit(record.value, { name: field("name"), description: field("description"), toolRefs: field("toolRefs") });
      } catch (error) {
        setNotice(String(error?.message || error), "error");
        return;
      }
      const saved = await saveRecord(record, value, record.value?.type === "tool-recipe" ? "工具配方已修订。" : "候选流程已修订。");
      if (saved) editingKey = "";
      renderCandidates();
      return;
    }
    if (command === "deactivate" || command === "activate") {
      const state = command === "deactivate" ? "inactive" : (record.value?.type === "tool-recipe" ? "active" : "candidate");
      const value = record.value?.type === "tool-recipe"
        ? prepareToolRecipeState(record.value, state)
        : prepareToolCandidateState(record.value, state);
      await saveRecord(record, value, state === "active" || state === "candidate" ? "工具条目已恢复启用。" : "工具条目已停用。", true);
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
  recipes?.addEventListener("click", event => {
    const element = event.target?.closest?.("button[data-tool-action]");
    if (element && recipes.contains(element)) void handleAction(element);
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
