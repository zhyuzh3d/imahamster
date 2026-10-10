import test from "node:test";
import assert from "node:assert/strict";
import { assertEventId, createEventReceipt, eventReceiptKey } from "./events.mjs";

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
