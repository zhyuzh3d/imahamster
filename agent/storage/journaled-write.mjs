import { attachJournalEvents } from "../observability/journal.mjs";

/** Convert a single store write to a batch without weakening its write conditions. */
export function prepareJournaledStoreWrite({
  method,
  params,
  state,
  events,
  checkpointCollection,
  checkpointKey,
}) {
  if (!state || !Array.isArray(events) || events.length === 0 || !["data.put", "data.batch"].includes(method)) {
    return null;
  }

  const operations = method === "data.put"
    ? [{
        op: "put",
        collection: params.collection,
        key: params.key,
        value: params.value,
        ...(Object.prototype.hasOwnProperty.call(params, "expectedRevision") ? { expectedRevision: params.expectedRevision } : {}),
      }]
    : params.operations;

  return {
    method: "data.batch",
    params: {
      operations: attachJournalEvents(state, operations, events, { checkpointCollection, checkpointKey }),
    },
    committedEvents: events,
  };
}
