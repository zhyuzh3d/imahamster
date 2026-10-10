import test from "node:test";
import assert from "node:assert/strict";
import { attachJournalEvents, JOURNAL_COLLECTION, makeJournalEntry } from "./journal.mjs";

test("journal entries carry task and action-loop identity in a stable ordered key", () => {
  const state = { goalId: "ost-1", taskId: "internal-1", runId: "run-1", actionLoop: { index: 3 } };
  assert.deepEqual(makeJournalEntry(state, 42, { phase: "model.requested", at: 100 }), {
    key: "e:ost-1:0000000042",
    value: { schemaVersion: 1, taskId: "ost-1", workItemId: "internal-1", runId: "run-1", actionLoopIndex: 3,
      sequence: 42, phase: "model.requested", at: 100 },
  });
});

test("journal records and current checkpoint are committed together without duplicate keys", () => {
  const state = { goalId: "ost-1", journalSequence: 2 };
  const events = [{ key: "e:ost-1:0000000003", value: { sequence: 3 } }];
  const operations = [{ op: "put", collection: "operations", key: "o:1", value: { status: "prepared" } },
    { op: "put", collection: "agent-runtime", key: "active-goal", value: {} }];
  const result = attachJournalEvents(state, operations, events, { checkpointCollection: "agent-runtime", checkpointKey: "active-goal" });
  assert.equal(result.length, 3);
  assert.equal(result.find((item) => item.collection === "agent-runtime").value, state);
  assert.equal(result.find((item) => item.collection === JOURNAL_COLLECTION).key, events[0].key);
  assert.throws(() => attachJournalEvents(state, [operations[1], operations[1]], events,
    { checkpointCollection: "agent-runtime", checkpointKey: "active-goal" }), /duplicate record keys/);
});
