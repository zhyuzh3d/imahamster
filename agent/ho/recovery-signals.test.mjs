import test from "node:test";
import assert from "node:assert/strict";
import { recordRecoveryFailure, recoverySignalSummary } from "./recovery-signals.mjs";

test("recovery failures accumulate by bounded stage and error category", () => {
  const state = {};
  recordRecoveryFailure(state, { stage: "provider-result", category: "model-temporary", code: "HTTP 503" });
  recordRecoveryFailure(state, { stage: "provider-result", category: "model-temporary", code: "HTTP 503" });
  recordRecoveryFailure(state, { stage: "action-result", category: "bridge", code: "E_CONFLICT" });

  assert.deepEqual(recoverySignalSummary(state), {
    total: 3,
    overflow: 0,
    categories: [
      { stage: "provider-result", category: "model-temporary", code: "http-503", count: 2 },
      { stage: "action-result", category: "bridge", code: "e_conflict", count: 1 },
    ],
  });
});

test("recovery signals omit error text and cap the number of category entries", () => {
  const state = {};
  for (let index = 0; index < 20; index += 1) {
    recordRecoveryFailure(state, {
      stage: `stage-${index}`,
      category: "network",
      code: `HTTP ${index}`,
    });
  }

  const summary = recoverySignalSummary(state);
  assert.equal(summary.total, 20);
  assert.equal(summary.categories.length, 12);
  assert.equal(summary.overflow, 8);
  assert.doesNotMatch(JSON.stringify(summary), /password|secret|response body/i);
});

test("missing recovery state is a safe empty view and malformed counters normalize", () => {
  assert.deepEqual(recoverySignalSummary(null), { total: 0, overflow: 0, categories: [] });
  assert.deepEqual(recoverySignalSummary({ recoverySignals: { total: "4", overflow: -1, categories: "bad" } }), {
    total: 4, overflow: 0, categories: [],
  });
});
