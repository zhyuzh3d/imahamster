import test from "node:test";
import assert from "node:assert/strict";
import { createTaskGraph, nextReadySubtask, setSubtaskState, taskGraphContext } from "./task-plan.mjs";

const goalId = "goal-plan-test";
const coordinatorTaskId = "task-plan-coordinator";

test("task graph maps LLM dependency indexes to stable Task IDs and schedules only ready work", () => {
  const graph = createTaskGraph([
    { objective: "读取当前会话的最新消息" },
    { objective: "结合上下文拟定回复", dependencies: [0], objectKey: "wechat:chat:zhyuzh" },
    { objective: "核对回复结果", dependencies: [1] },
    { objective: "整理本次会话观察", dependencies: [0] },
  ], { goalId, coordinatorTaskId, createdAt: 100, makeRunId: index => `run-${index}` });

  assert.equal(graph.tasks.length, 4);
  assert.equal(graph.tasks[0].state, "running");
  assert.deepEqual(graph.tasks[1].dependencies, [graph.tasks[0].taskId]);
  assert.deepEqual(graph.tasks[3].dependencies, [graph.tasks[0].taskId]);
  assert.equal(nextReadySubtask(graph), null, "the HO must not start work before the current unit is complete");
  const afterFirst = setSubtaskState(graph, graph.tasks[0].taskId, "done", { progress: "已确认最新消息", at: 120 });
  assert.equal(nextReadySubtask(afterFirst).taskId, graph.tasks[1].taskId);
  const afterSecond = setSubtaskState(afterFirst, graph.tasks[1].taskId, "done", { at: 140 });
  assert.equal(nextReadySubtask(afterSecond).taskId, graph.tasks[2].taskId,
    "ready order is deterministic and a task's dependency must be done");
});

test("task graph rejects malformed objectives, duplicate IDs, forward edges, and oversized plans", () => {
  const options = { goalId, coordinatorTaskId, makeTaskId: index => `task-${index}` };
  assert.throws(() => createTaskGraph([{ objective: "one" }], options), /2 to 31/);
  assert.throws(() => createTaskGraph([
    { objective: "one", dependencies: [0] }, { objective: "two" },
  ], options), /earlier tasks/);
  assert.throws(() => createTaskGraph([
    { objective: "one" }, { objective: " " },
  ], options), /objective/);
  assert.throws(() => createTaskGraph([
    { objective: "one" }, { objective: "two" },
  ], { ...options, makeTaskId: () => "duplicate" }), /duplicate IDs/);
  assert.throws(() => createTaskGraph(Array.from({ length: 32 }, (_, index) => ({ objective: `task ${index}` })), options), /2 to 31/);
});

test("task context keeps the original goal distinct from the scheduled unit and final review", () => {
  const graph = createTaskGraph([
    { objective: "读取新消息" }, { objective: "回复并核验", dependencies: [0] },
  ], { goalId, coordinatorTaskId, makeRunId: index => `run-${index}` });
  assert.match(taskGraphContext(graph, graph.tasks[0].taskId), /整体用户目标仍是上文原始指令/);
  assert.match(taskGraphContext(graph, graph.tasks[0].taskId), /task-done/);
  assert.match(taskGraphContext(graph, coordinatorTaskId, { review: true }), /整体目标是否完成/);
});
