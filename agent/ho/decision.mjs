const ACTION_TYPES = new Set(["tap", "swipe", "input", "back", "home"]);
const EFFECTS = new Set(["none", "send", "submit", "publish", "friend-add", "external", "delete", "purchase", "permission"]);
const RESTRICTED_EFFECTS = new Set(["delete", "purchase", "permission"]);
const CONFIRM_EFFECTS = new Set(["send", "submit", "publish"]);
const TARGET_EFFECTS = new Set(["friend-add", "external"]);

export function validateScreenAction(action) {
  if (!action || typeof action !== "object") throw new Error("模型动作对象缺失");
  if (typeof action.target !== "string" || !action.target.trim()) throw new Error("模型动作目标缺失");
  if (action.type === "tap" && (![action.x, action.y].every(Number.isFinite) ||
      action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1)) throw new Error("点击坐标无效");
  if (action.type === "swipe" && ![action.fromX, action.fromY, action.toX, action.toY]
    .every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("滑动坐标无效");
  if (action.type === "input" && ![action.x, action.y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error("输入框坐标无效");
  }
  if (action.type === "input" && (action.focused !== true || !["append", "replace"].includes(action.mode) ||
      typeof action.text !== "string" || !action.text.trim() || action.text.length > 8192)) {
    throw new Error("输入框状态或输入内容无效");
  }
  if (action.type === "input" && action.inputStrategy !== undefined &&
      !["accessibility", "clipboard-paste"].includes(action.inputStrategy)) {
    throw new Error("不支持的文字输入策略");
  }
  if (!ACTION_TYPES.has(action.type)) throw new Error("当前版本不支持此屏幕动作");
  const effect = action.effect || "none";
  if (!EFFECTS.has(effect)) throw new Error("未知操作影响类型");
  if (RESTRICTED_EFFECTS.has(effect)) throw new Error("此类高影响动作暂不由后台 Worker 自动执行");
  if (CONFIRM_EFFECTS.has(effect) && (action.type !== "tap" || !action.visibleTarget?.trim() ||
      !action.visibleContent?.trim() || !action.label?.trim())) {
    throw new Error("发送或发布前必须核对截图中的对象、完整内容和按钮");
  }
  if (TARGET_EFFECTS.has(effect) && (action.type !== "tap" || !action.visibleTarget?.trim())) {
    throw new Error("外部社交操作前必须核对截图中的目标对象");
  }
  return action;
}
