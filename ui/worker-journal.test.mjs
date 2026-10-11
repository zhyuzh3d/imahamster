import test from "node:test";
import assert from "node:assert/strict";
import { formatWorkerJournal, mountWorkerJournal } from "./worker-journal.mjs";

test("worker journal formatting keeps full structured event details within the display bound", () => {
  const detail = { purpose: "action", contextManifest: { selected: { memories: [{ ref: "memory:friend" }] } } };
  const output = formatWorkerJournal([{ key: "e:g:1", value: { at: 0, step: 2, phase: "model.requested", ...detail } }]);
  assert.match(output, /#2 model\.requested/);
  assert.match(output, /contextManifest/);
  assert.match(output, /memory:friend/);
  assert.doesNotMatch(output, /详情截断/);
});

test("worker journal formatting bounds oversized events and handles malformed records", () => {
  const output = formatWorkerJournal([
    { key: "e:g:1", value: { phase: "large", payload: "x".repeat(5000) } },
    { key: "e:g:2", value: null },
    { key: "e:g:3" },
  ], { hasMore: true });
  assert.match(output, /还有事件待加载/);
  assert.match(output, /详情截断/);
  assert.match(output, /event \{\}/);
  assert.ok(output.length < 5000);
});

test("worker journal polls incrementally only while details are open", async () => {
  class Element {
    constructor() { this.listeners = new Map(); this.open = false; this.hidden = false; this.disabled = false; this.textContent = ""; }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    emit(type) { this.listeners.get(type)?.(); }
  }
  const elements = new Map(["#worker-journal-details", "#worker-journal-refresh", "#worker-journal-events"]
    .map(selector => [selector, new Element()]));
  const root = { querySelector: selector => elements.get(selector) };
  const calls = [];
  const host = () => ({ isReady: true, data: { scan: async params => {
    calls.push(params);
    if (!params.afterKey) return { items: [1, 2].map(sequence => ({ key: `e:task:${sequence}`, value: { phase: "step", sequence } })), nextAfterKey: "e:task:2" };
    if (params.afterKey === "e:task:2") return { items: [{ key: "e:task:3", value: { phase: "step", sequence: 3 } }] };
    return { items: [{ key: "e:task:4", value: { phase: "step", sequence: 4 } }] };
  } } });
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let poll;
  let cleared = false;
  globalThis.setInterval = callback => { poll = callback; return 123; };
  globalThis.clearInterval = () => { cleared = true; };
  try {
    const controller = mountWorkerJournal({ root, host });
    controller.setGoalId("task");
    controller.setReady(true);
    const details = elements.get("#worker-journal-details");
    details.open = true;
    details.emit("toggle");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2);
    assert.match(elements.get("#worker-journal-events").textContent, /#0 step.*"sequence":3/);
    poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[2].afterKey, "e:task:3");
    assert.match(elements.get("#worker-journal-events").textContent, /"sequence":4/);
    details.open = false;
    details.emit("toggle");
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
