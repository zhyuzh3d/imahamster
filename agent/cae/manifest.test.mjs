import test from "node:test";
import assert from "node:assert/strict";
import { buildContextManifest } from "./manifest.mjs";

test("CAE manifest records selected versions, bounded source refs, observation, and omissions without content", () => {
  const state = {
    goalId: "ost-1",
    actionLoop: { index: 3 },
    actionLoopHistory: Array.from({ length: 8 }, (_, index) => ({ index: index + 1, status: "reviewed" })),
    trace: Array.from({ length: 23 }, (_, index) => ({
      at: 1000 + index, step: index, phase: index === 22 ? "screenshot.received" : "decision",
      width: index === 22 ? 1080 : undefined, height: index === 22 ? 2400 : undefined,
    })),
    experiences: Array.from({ length: 6 }, (_, index) => ({ sourceRef: `knowledge:experience:${index}`, recordRevision: "7" })),
    memories: Array.from({ length: 6 }, (_, index) => ({ id: `memory:${index}`, revision: 2, recordRevision: "8", content: "PRIVATE MEMORY" })),
    memoryLookupRefs: Array.from({ length: 9 }, (_, index) => `contact:${index}`),
    behaviorPatterns: Array.from({ length: 6 }, (_, index) => ({ sourceRef: `self-model:bp:${index}`, recordRevision: "9" })),
    toolCandidates: Array.from({ length: 4 }, (_, index) => ({ sourceRef: `knowledge:tool-candidate:${index}`, recordRevision: "10" })),
  };

  const manifest = buildContextManifest(state, {
    purpose: "action", context: "short assembled context", identityCore: { content: "PRIVATE IDENTITY", version: 4 },
  });

  assert.equal(manifest.ostId, "ost-1");
  assert.equal(manifest.alId, 3);
  assert.equal(manifest.currentObservation.width, 1080);
  assert.match(manifest.currentObservationRef, /^trace:ost-1:/);
  assert.equal(manifest.selected.history.length, 20);
  assert.equal(manifest.selected.experiences.length, 5);
  assert.equal(manifest.selected.memories[0].revision, "2");
  assert.equal(manifest.selected.memories[0].recordRevision, "8");
  assert.deepEqual(manifest.selected.identityCore, { source: "user", version: 4 });
  assert.deepEqual(manifest.omitted, {
    history: 3, actionLoops: 2, experiences: 1, memories: 1,
    memoryLookupRefs: 1, behaviorPatterns: 1, toolCandidates: 1,
  });
  assert.equal(manifest.contextCharacters, "short assembled context".length);
  assert.equal(manifest.approximateContextTokens, 6);
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE MEMORY|PRIVATE IDENTITY/);
});

test("CAE rejects missing state when producing a context manifest", () => {
  assert.throws(() => buildContextManifest(null), /有效的 OST 状态/);
});
