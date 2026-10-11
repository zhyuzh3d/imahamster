import { mountBehaviorPatternsPanel } from "./behavior-patterns.mjs";
import { mountMemoryPanel } from "./memory.mjs";

export function mountSelfModelPanel(options) {
  const memory = mountMemoryPanel(options);
  const patterns = mountBehaviorPatternsPanel(options);
  return {
    setReady(value) {
      memory.setReady(value);
      patterns.setReady(value);
    },
    refresh() {
      return Promise.all([memory.refresh(), patterns.refresh()]);
    },
  };
}
