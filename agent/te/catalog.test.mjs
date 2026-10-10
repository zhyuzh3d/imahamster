import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_CATALOG, formatToolNames, isRegisteredTool } from "./catalog.mjs";

test("TE exposes only the screen primitives that the Worker can execute", () => {
  assert.deepEqual(TOOL_CATALOG.map(tool => tool.name), [
    "interaction.capture", "interaction.tap", "interaction.swipe", "interaction.inputText", "interaction.globalAction",
  ]);
  assert.equal(formatToolNames(), "可用工具：interaction.capture、interaction.tap、interaction.swipe、interaction.inputText、interaction.globalAction");
  assert.equal(isRegisteredTool("interaction.tap"), true);
  assert.equal(isRegisteredTool("network.request"), false);
  assert.equal(isRegisteredTool("shell.exec"), false);
});
