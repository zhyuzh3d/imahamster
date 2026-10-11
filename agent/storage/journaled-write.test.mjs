import assert from "node:assert/strict";
import test from "node:test";
import { prepareJournaledStoreWrite } from "./journaled-write.mjs";

const state = { goalId: "goal-1", revision: 4, journalSequence: 1 };
const events = [{ key: "e:goal-1:0000000001", value: { phase: "test" } }];
const checkpoint = { checkpointCollection: "agent-runtime", checkpointKey: "active-goal" };

test("journal wrapping preserves the compare-and-swap condition on a data.put", () => {
  const prepared = prepareJournaledStoreWrite({
    method: "data.put",
    params: { collection: "agent-runtime", key: "active-goal", value: state, expectedRevision: "rev-9" },
    state,
    events,
    ...checkpoint,
  });

  assert.equal(prepared.method, "data.batch");
  assert.deepEqual(prepared.params.operations[0], {
    op: "put", collection: "agent-runtime", key: "active-goal", value: state, expectedRevision: "rev-9",
  });
  assert.equal(prepared.params.operations.at(-1).collection, "agent-events");
  assert.deepEqual(prepared.committedEvents, events);
});

test("journal wrapping preserves per-record write conditions in an existing batch", () => {
  const operations = [
    { op: "put", collection: "memory", key: "m:1", value: { revision: 2 }, expectedRevision: "rev-2" },
    { op: "delete", collection: "inbox", key: "q:1", expectedRevision: "rev-7" },
  ];
  const prepared = prepareJournaledStoreWrite({
    method: "data.batch", params: { operations }, state, events, ...checkpoint,
  });

  assert.deepEqual(prepared.params.operations.slice(0, 2), operations);
  assert.equal(prepared.params.operations.length, 4);
});

test("non-journaled writes keep their original one-call shape", () => {
  assert.equal(prepareJournaledStoreWrite({
    method: "data.put", params: { collection: "memory", key: "m:1", value: {} }, state,
    events: [], ...checkpoint,
  }), null);
});
