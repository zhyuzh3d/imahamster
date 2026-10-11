import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolCandidateRecord, prepareToolCandidateEdit, prepareToolCandidateState } from "./candidate.mjs";

test("TE candidate records retain source and Bridge revision while remaining non-executable", () => {
  const candidate = normalizeToolCandidateRecord({ key: "tool-candidate:g1", revision: "7", value: {
    type: "tool-candidate", state: "candidate", name: "先观察再回复", description: "核对界面再按证据操作",
    toolRefs: ["interaction.capture", "shell.exec", "interaction.tap"], sourceGoalId: "g1", revision: 2,
  } });
  assert.deepEqual(candidate, {
    schemaVersion: 1, type: "tool-candidate", state: "candidate", name: "先观察再回复",
    description: "核对界面再按证据操作", toolRefs: ["interaction.capture", "interaction.tap"],
    sourceRef: "knowledge:tool-candidate:g1", recordRevision: "7",
  });
  assert.equal("sourceGoalId" in candidate, false);
  assert.equal("revision" in candidate, false);
  assert.equal(normalizeToolCandidateRecord({ value: { ...candidate, state: "inactive" } }), null);
  assert.equal(normalizeToolCandidateRecord({ value: { ...candidate, state: "inactive" } }, { includeInactive: true })?.state, "inactive");
});

test("TE candidate edits validate registered tools and preserve provenance", () => {
  const current = { type: "tool-candidate", state: "candidate", name: "旧名称", description: "旧说明",
    toolRefs: ["interaction.tap"], sourceGoalId: "g2", createdAt: 10, revision: 3 };
  const edited = prepareToolCandidateEdit(current, {
    name: " 新名称 ", description: " 新说明 ", toolRefs: "interaction.capture, interaction.tap, interaction.capture",
  }, 20);
  assert.equal(edited.name, "新名称");
  assert.deepEqual(edited.toolRefs, ["interaction.capture", "interaction.tap"]);
  assert.equal(edited.revision, 4);
  assert.equal(edited.updatedAt, 20);
  assert.equal(edited.sourceGoalId, "g2");
  assert.throws(() => prepareToolCandidateEdit(current, { name: "x", description: "y", toolRefs: "shell.exec" }), /已注册工具/);
  assert.deepEqual(prepareToolCandidateState(edited, "inactive", 30).state, "inactive");
});
