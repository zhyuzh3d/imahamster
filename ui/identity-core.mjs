import { DEFAULT_IDENTITY_CORE, normalizeIdentityCoreRecord, prepareIdentityCoreEdit } from "../agent/sm/identity-core.mjs";

export function mountIdentityCorePanel({ root = globalThis.document, host = () => globalThis.window?.haminn } = {}) {
  const $ = selector => root?.querySelector?.(selector);
  const details = $("#ic-details");
  const notice = $("#ic-notice");
  const meta = $("#ic-meta");
  const content = $("#ic-content");
  const editor = $("#ic-editor");
  const actions = $("#ic-actions");
  const refreshButton = $("#ic-refresh");
  let value = null;
  let hostRevision = null;
  let loaded = false;
  let loading = false;
  let editing = false;
  let ready = false;

  function setNotice(text, tone = "") {
    if (!notice) return;
    notice.textContent = text;
    notice.dataset.tone = tone;
  }

  function actionButton(label, command, className = "button secondary") {
    const button = root.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.dataset.icAction = command;
    button.disabled = loading;
    return button;
  }

  function render() {
    if (!value) return;
    if (meta) meta.textContent = value.version > 0
      ? "已保存版本 " + value.version + (value.updatedAt ? " · " + new Date(value.updatedAt).toLocaleString() : "")
      : "包内初始文档 · 尚未保存用户修订";
    if (content) {
      content.textContent = value.content;
      content.hidden = editing;
    }
    if (editor) {
      editor.value = value.content;
      editor.hidden = !editing;
      editor.disabled = loading;
    }
    if (actions) {
      actions.replaceChildren();
      if (editing) actions.append(actionButton("保存新版本", "save"), actionButton("取消", "cancel"));
      else actions.append(actionButton("编辑 Identity Core", "edit"));
    }
  }

  async function load() {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading) return;
    loading = true;
    if (refreshButton) refreshButton.disabled = true;
    setNotice("正在读取 Identity Core…");
    try {
      const record = await bridge.data.get({ collection: "self-model", key: "identity-core" });
      const normalized = normalizeIdentityCoreRecord(record?.value);
      value = normalized || {
        schemaVersion: 1, type: "identity-core", content: DEFAULT_IDENTITY_CORE, version: 0,
      };
      hostRevision = record?.revision || null;
      loaded = true;
      setNotice(normalized ? "用户 Identity Core 已加载。" : record
        ? "保存记录格式无效；当前暂用包内初始文档，保存可创建修订版。"
        : "当前使用包内初始文档；保存后会创建用户版本。");
      render();
    } catch (error) {
      setNotice("读取 Identity Core 失败：" + String(error?.message || error).slice(0, 220), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      render();
    }
  }

  async function handleAction(button) {
    const bridge = host();
    if (!ready || !bridge?.isReady || loading || !value) return;
    const command = button.dataset.icAction;
    if (command === "edit") {
      editing = true;
      render();
      return;
    }
    if (command === "cancel") {
      editing = false;
      render();
      return;
    }
    if (command !== "save") return;
    let next;
    const draft = editor?.value || "";
    try { next = prepareIdentityCoreEdit(value.version > 0 ? value : null, editor?.value || ""); }
    catch (error) { setNotice(String(error?.message || error), "error"); return; }
    let saved = false;
    loading = true;
    render();
    try {
      const result = await bridge.data.put({ collection: "self-model", key: "identity-core", value: next,
        expectedRevision: hostRevision || "absent" });
      value = next;
      hostRevision = result?.revision || hostRevision;
      editing = false;
      saved = true;
      setNotice("Identity Core 已保存为新版本；后续需要角色上下文的 OST 会读取该版本。", "success");
    } catch (error) {
      setNotice("保存失败；记录可能已在其他位置更新，请刷新后重试。 " + String(error?.message || error).slice(0, 180), "error");
    } finally {
      loading = false;
      if (refreshButton) refreshButton.disabled = !ready;
      render();
      if (!saved && editor && editing) editor.value = draft;
    }
  }

  details?.addEventListener("toggle", () => { if (details.open && ready && !loaded) void load(); });
  refreshButton?.addEventListener("click", () => { void load(); });
  actions?.addEventListener("click", event => {
    const button = event.target?.closest?.("button[data-ic-action]");
    if (button && actions.contains(button)) void handleAction(button);
  });

  return {
    setReady(isReady) {
      ready = Boolean(isReady);
      if (refreshButton) refreshButton.disabled = !ready;
      if (ready && details?.open && !loaded) void load();
    },
    refresh: () => load(),
  };
}
