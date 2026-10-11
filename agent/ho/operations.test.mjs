import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCurrentOperationOutcome,
  ensurePendingOperationHistory,
  pendingOperationContext,
  rememberPendingOperation,
} from "./operations.mjs";

test("unknown operation remains in the unresolved index after a newer action replaces the current pointer", () => {
  const state = {
    pendingOperationId: "old-send",
    pendingOperation: { operationId: "old-send", status: "returned", kind: "send", target: "contact A", createdAt: 10 },
    pendingOperations: [],
  };

  const old = applyCurrentOperationOutcome(state, "unknown", "当前画面无法确认发送结果", 20);
  assert.equal(old.status, "unknown");
  assert.deepEqual(state.pendingOperations.map(item => item.operationId), ["old-send"]);
  state.pendingOperationId = "new-observation-action";
  state.pendingOperation = { operationId: "new-observation-action", status: "prepared", kind: "tap", target: "refresh", createdAt: 30 };

  const context = pendingOperationContext(state);
  assert.deepEqual(context.items.map(item => item.operationId), ["old-send", "new-observation-action"]);
  assert.equal(context.items[0].status, "unknown");
  assert.equal(context.items[1].current, true);
});

test("resolved operation is removed while its durable operation record remains the caller's responsibility", () => {
  const state = {
    pendingOperationId: "send-1",
    pendingOperation: { operationId: "send-1", status: "returned", kind: "send", createdAt: 10 },
  };
  ensurePendingOperationHistory(state);
  const operation = applyCurrentOperationOutcome(state, "verified", "消息气泡可见", 40);
  assert.equal(operation.status, "verified");
  assert.equal(state.pendingOperationId, null);
  assert.deepEqual(state.pendingOperations, []);
});

test("legacy current operation is recovered and older unresolved references are bounded", () => {
  const state = { pendingOperationId: "legacy", pendingOperation: { operationId: "legacy", status: "returned", createdAt: 100 } };
  assert.equal(ensurePendingOperationHistory(state).length, 1);
  for (let index = 0; index < 50; index += 1) {
    rememberPendingOperation(state, { operationId: `op-${index}`, status: "unknown", createdAt: index });
  }
  const context = pendingOperationContext(state, { limit: 5 });
  assert.equal(state.pendingOperations.length, 40);
  assert.ok(state.pendingOperationReferenceOverflow > 0);
  assert.equal(context.items.length <= 6, true);
  assert.ok(context.hiddenCount > 0);
});
