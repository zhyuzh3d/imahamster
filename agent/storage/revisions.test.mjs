import assert from "node:assert/strict";
import test from "node:test";
import {
  clearLifecycleRevisions,
  hasLifecycleWrite,
  knowsLifecycleRevision,
  lifecycleStoreContractError,
  observeStoreEffectResult,
  prepareRevisionCheckedWrite,
} from "./revisions.mjs";

test("known lifecycle revisions are attached to writes without overriding explicit conditions", () => {
  const revisions = new Map();
  observeStoreEffectResult(revisions, "data.get", { collection: "agent-runtime", key: "active-goal" },
    { revision: "r-3", value: {} });

  assert.deepEqual(prepareRevisionCheckedWrite("data.put", {
    collection: "agent-runtime", key: "active-goal", value: {},
  }, revisions), {
    collection: "agent-runtime", key: "active-goal", value: {}, expectedRevision: "r-3",
  });
  assert.equal(prepareRevisionCheckedWrite("data.put", {
    collection: "agent-runtime", key: "active-goal", value: {}, expectedRevision: "r-explicit",
  }, revisions).expectedRevision, "r-explicit");
  assert.equal(hasLifecycleWrite("data.put", { collection: "agent-runtime", key: "active-goal" }), true);
  assert.equal(hasLifecycleWrite("data.put", { collection: "agent-runtime", key: "event:receipt" }), false);
  assert.equal(hasLifecycleWrite("data.put", { collection: "knowledge", key: "memory:1" }), false);
});

test("batch writes receive known revisions while preserving non-lifecycle and explicit operations", () => {
  const revisions = new Map();
  observeStoreEffectResult(revisions, "data.scan", { collection: "tasks" }, {
    items: [{ collection: "tasks", key: "t:1", revision: "task-r1", value: {} }],
  });
  const params = { operations: [
    { op: "put", collection: "tasks", key: "t:1", value: {} },
    { op: "delete", collection: "inbox", key: "q:1", expectedRevision: "queue-r1" },
    { op: "put", collection: "knowledge", key: "memory:1", value: {} },
  ] };

  const prepared = prepareRevisionCheckedWrite("data.batch", params, revisions);
  assert.equal(prepared.operations[0].expectedRevision, "task-r1");
  assert.equal(prepared.operations[1].expectedRevision, "queue-r1");
  assert.equal(Object.hasOwn(prepared.operations[2], "expectedRevision"), false);
  assert.equal(Object.hasOwn(params.operations[0], "expectedRevision"), false);
  assert.equal(hasLifecycleWrite("data.batch", prepared), true);
  assert.equal(knowsLifecycleRevision(revisions, "tasks", "t:1"), true);
  assert.equal(knowsLifecycleRevision(revisions, "tasks", "t:missing"), false);
});

test("acknowledged write results advance or clear the revision ledger", () => {
  const revisions = new Map();
  const params = { operations: [
    { op: "put", collection: "goals", key: "g:1", value: {} },
    { op: "delete", collection: "tasks", key: "t:old", expectedRevision: "old-r1" },
  ] };
  observeStoreEffectResult(revisions, "data.batch", params, { results: [
    { op: "put", key: "g:1", revision: "goal-r2" },
    { op: "delete", key: "t:old", deleted: true },
  ] });

  assert.equal(prepareRevisionCheckedWrite("data.put", {
    collection: "goals", key: "g:1", value: {},
  }, revisions).expectedRevision, "goal-r2");
  assert.equal(prepareRevisionCheckedWrite("data.put", {
    collection: "tasks", key: "t:old", value: {},
  }, revisions).expectedRevision, "absent");
  clearLifecycleRevisions(revisions);
  assert.equal(revisions.size, 0);
});

test("a confirmed missing lifecycle record is written with the absent condition", () => {
  const revisions = new Map();
  observeStoreEffectResult(revisions, "data.get", { collection: "goals", key: "g:new" }, null);
  assert.equal(prepareRevisionCheckedWrite("data.batch", { operations: [
    { op: "put", collection: "goals", key: "g:new", value: {} },
  ] }, revisions).operations[0].expectedRevision, "absent");
});

test("a malformed record without a revision does not masquerade as an absent record", () => {
  const revisions = new Map([["agent-runtime\u0000active-goal", "known-r1"]]);
  observeStoreEffectResult(revisions, "data.get", { collection: "agent-runtime", key: "active-goal" }, { value: {} });
  assert.equal(prepareRevisionCheckedWrite("data.put", {
    collection: "agent-runtime", key: "active-goal", value: {},
  }, revisions).expectedRevision, "known-r1");
});

test("malformed Host results cannot silently disable lifecycle CAS", () => {
  assert.match(lifecycleStoreContractError("data.get", {
    collection: "agent-runtime", key: "active-goal",
  }, { value: {} }), /Host revision/);
  assert.match(lifecycleStoreContractError("data.batch", { operations: [
    { op: "put", collection: "tasks", key: "t:1", value: {} },
  ] }, { results: [] }), /Host revision/);
  assert.equal(lifecycleStoreContractError("data.get", {
    collection: "agent-runtime", key: "active-goal",
  }, null), null);
  assert.equal(lifecycleStoreContractError("data.put", {
    collection: "knowledge", key: "memory:1", value: {},
  }, {}), null);
});
