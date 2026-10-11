import test from "node:test";
import assert from "node:assert/strict";
import { assertEventId, assertEventReceiptIdentity, createEventReceipt, eventReceiptKey } from "./events.mjs";

test("event receipts use a bounded stable key and retain source identity", () => {
  const id = "notification:com.example:posted:42";
  assert.equal(eventReceiptKey(id), eventReceiptKey(id));
  assert.match(eventReceiptKey(id), /^event:[0-9a-f]{16}$/);
  assert.deepEqual(createEventReceipt(id, "notification.received", { ostId: "ost-1" }, 500), {
    schemaVersion: 1, eventId: id, type: "notification.received", state: "accepted", acceptedAt: 500, ostId: "ost-1",
  });
});

test("event identity rejects empty, non-string, and oversized values", () => {
  for (const value of ["", null, 42, "x".repeat(257)]) assert.throws(() => assertEventId(value), /eventId/);
});

test("a receipt is accepted only for the matching event ID and event type", () => {
  const receipt = createEventReceipt("notification:source:1", "notification.posted");
  assert.equal(assertEventReceiptIdentity(receipt, "notification:source:1", "notification.posted"), receipt);
  assert.throws(() => assertEventReceiptIdentity(receipt, "timer:source:1", "timer.fired"), /identity mismatch/);
  assert.throws(() => assertEventReceiptIdentity(receipt, "notification:source:1", "goal.submit"), /identity mismatch/);
});
