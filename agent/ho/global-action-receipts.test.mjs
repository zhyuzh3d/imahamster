import test from "node:test";
import assert from "node:assert/strict";
import {
  beginGlobalActionReceipt,
  classifyGlobalActionStatus,
  MAX_GLOBAL_ACTION_STATUS_POLLS,
} from "./global-action-receipts.mjs";

test("scheduled navigation receipt is polled and classified without replaying the action", () => {
  const receipt = beginGlobalActionReceipt({ state: "scheduled", action: "back", operationId: "ga-1", scheduledAt: 100 }, 120);
  assert.deepEqual(receipt, {
    operationId: "ga-1", action: "back", state: "scheduled", scheduledAt: 100, startedAt: 120, polls: 0,
  });
  const pending = classifyGlobalActionStatus({ found: true, state: "scheduled", operationId: "ga-1" }, receipt);
  assert.equal(pending.kind, "pending");
  assert.equal(pending.polls, 1);
  const accepted = classifyGlobalActionStatus({ found: true, state: "accepted", operationId: "ga-1" }, {
    ...receipt, polls: pending.polls,
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.polls, 2);
});

test("missing, rejected, and persistently scheduled receipts become explicit final outcomes", () => {
  const receipt = beginGlobalActionReceipt({ state: "scheduled", action: "home", operationId: "ga-2" }, 120);
  assert.equal(classifyGlobalActionStatus({ found: false, operationId: "ga-2" }, receipt).state, "unknown");
  assert.equal(classifyGlobalActionStatus({ found: true, state: "rejected", operationId: "ga-2", error: "system_rejected" }, receipt).error,
    "system_rejected");
  const timedOut = classifyGlobalActionStatus({ found: true, state: "scheduled", operationId: "ga-2" }, {
    ...receipt, polls: MAX_GLOBAL_ACTION_STATUS_POLLS - 1,
  });
  assert.equal(timedOut.kind, "final");
  assert.equal(timedOut.state, "unknown");
  assert.equal(timedOut.error, "status-poll-limit");
});
