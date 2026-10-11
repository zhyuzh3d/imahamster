import { mountBehaviorPatternsPanel } from "./behavior-patterns.mjs";
import { mountIdentityCorePanel } from "./identity-core.mjs";
import { mountMemoryPanel } from "./memory.mjs";

export function mountSelfModelPanel(options) {
  const identityCore = mountIdentityCorePanel(options);
  const memory = mountMemoryPanel(options);
  const patterns = mountBehaviorPatternsPanel(options);
  return {
    setReady(value) {
      identityCore.setReady(value);
      memory.setReady(value);
      patterns.setReady(value);
    },
    refresh() {
      return Promise.all([identityCore.refresh(), memory.refresh(), patterns.refresh()]);
    },
  };
}
