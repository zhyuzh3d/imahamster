export function assertEventId(eventId) {
  if (typeof eventId !== "string" || !eventId || eventId.length > 256) {
    throw new TypeError("An eventId of at most 256 characters is required");
  }
  return eventId;
}

export function eventReceiptKey(eventId) {
  const value = assertEventId(eventId);
  return `event:${fnv1a64(value)}`;
}

export function createEventReceipt(eventId, type, fields = {}, at = Date.now()) {
  return {
    schemaVersion: 1,
    eventId: assertEventId(eventId),
    type: String(type || "unknown").slice(0, 80),
    state: "accepted",
    acceptedAt: Number(at),
    ...fields,
  };
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}
