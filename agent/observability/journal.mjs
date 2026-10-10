export const JOURNAL_COLLECTION = "agent-events";

export function attachJournalEvents(state, operations, events, { checkpointCollection, checkpointKey }) {
  if (!Array.isArray(events) || events.length === 0) return operations;
  if (!Array.isArray(operations)) throw new TypeError("Journal writes require a storage batch");

  const output = operations.map((operation) => ({ ...operation }));
  const checkpoint = output.find((operation) => operation.collection === checkpointCollection && operation.key === checkpointKey);
  if (checkpoint) checkpoint.value = state;
  else output.push({ op: "put", collection: checkpointCollection, key: checkpointKey, value: state });

  for (const event of events) {
    output.push({
      op: "put",
      collection: JOURNAL_COLLECTION,
      key: event.key,
      value: event.value,
    });
  }
  if (output.length > 100) throw new RangeError("Journal and checkpoint exceed one Haminn storage batch");
  const keys = new Set();
  for (const operation of output) {
    const identity = `${operation.collection}\u0000${operation.key}`;
    if (keys.has(identity)) throw new TypeError("Journal batch contains duplicate record keys");
    keys.add(identity);
  }
  return output;
}

export function makeJournalEntry(state, sequence, event) {
  const taskId = String(state?.goalId || "unassigned");
  const key = `e:${taskId}:${String(sequence).padStart(10, "0")}`;
  return {
    key,
    value: {
      schemaVersion: 1,
      taskId,
      workItemId: state?.taskId || null,
      runId: state?.runId || null,
      actionLoopIndex: Number(state?.actionLoop?.index) || null,
      sequence,
      ...event,
    },
  };
}
