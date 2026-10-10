/** Executable screen primitives available to the current Worker. */
export const TOOL_CATALOG = Object.freeze([
  Object.freeze({ name: "interaction.capture", kind: "screen-observation" }),
  Object.freeze({ name: "interaction.tap", kind: "screen-action" }),
  Object.freeze({ name: "interaction.swipe", kind: "screen-action" }),
  Object.freeze({ name: "interaction.inputText", kind: "screen-action" }),
  Object.freeze({ name: "interaction.globalAction", kind: "screen-action" }),
]);

const toolNames = new Set(TOOL_CATALOG.map(tool => tool.name));

export function formatToolNames() {
  return `可用工具：${TOOL_CATALOG.map(tool => tool.name).join("、")}`;
}

export function isRegisteredTool(name) {
  return typeof name === "string" && toolNames.has(name);
}
