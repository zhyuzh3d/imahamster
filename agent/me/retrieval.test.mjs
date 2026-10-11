import test from "node:test";
import assert from "node:assert/strict";
import { retrieveRelevantExperiences } from "./retrieval.mjs";

const exp = (title, situation, createdAt = 0, extra = {}) => ({
  value: { type: "experience", state: "active", title, situation, approach: "先观察再行动", successEvidence: "结果已确认", createdAt, ...extra },
});

test("ME ranks relevant Chinese and Latin experiences and excludes unrelated knowledge", () => {
  const items = [
    exp("微信发消息", "在微信聊天窗口核对收件人后发送", 10),
    exp("天气查询", "打开天气应用查看明天预报", 20),
    exp("上下文回复", "根据最新消息和历史聊天内容回复好友", 30),
    { value: { type: "tool-candidate", state: "candidate", title: "微信聊天", situation: "消息发送" } },
    exp("已停用回复方法", "微信聊天回复", 100, { state: "inactive" }),
  ];

  const result = retrieveRelevantExperiences("根据微信消息上下文回复好友", items, { limit: 5 });

  assert.deepEqual(result.map(item => item.title), ["上下文回复", "微信发消息"]);
  assert.ok(result.every(item => item.type === "experience" && item.state === "active"));
  assert.ok(result.every(item => !("sourceGoalId" in item)));
});

test("ME uses recency to break equal relevance and bounds returned records", () => {
  const items = [
    exp("WeChat old", "Open WeChat chat", 1, { approach: "x".repeat(2000), sourceGoalId: "private-id" }),
    exp("WeChat recent", "Open WeChat chat", 2),
  ];
  const result = retrieveRelevantExperiences("Open WeChat", items, { limit: 1 });
  const both = retrieveRelevantExperiences("Open WeChat", items, { limit: 2 });

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "WeChat recent");
  assert.equal(both[1].title, "WeChat old");
  assert.equal(both[1].approach.length, 800);
  assert.equal("sourceGoalId" in both[1], false);
});

test("ME preserves experience revisions and uses their latest edit time for retrieval order", () => {
  const items = [
    exp("微信回复旧经验", "微信朋友消息回复", 10, { revision: 1, updatedAt: 20 }),
    exp("微信回复已修订经验", "微信朋友消息回复", 1, { revision: 4, updatedAt: 100 }),
  ];
  const result = retrieveRelevantExperiences("微信朋友消息回复", items, { limit: 1 });
  assert.equal(result[0].title, "微信回复已修订经验");
  assert.equal(result[0].revision, 4);
  assert.equal(result[0].updatedAt, 100);
});

test("ME returns no memories when the task has no matching concepts", () => {
  assert.deepEqual(retrieveRelevantExperiences("打开相机", [exp("微信回复", "聊天消息")]), []);
  assert.deepEqual(retrieveRelevantExperiences("?", [exp("微信回复", "聊天消息")]), []);
});

test("ME rejects invalid query parameters", () => {
  assert.throws(() => retrieveRelevantExperiences(null, []), /参数无效/);
  assert.throws(() => retrieveRelevantExperiences("任务", {}, {}), /参数无效/);
  assert.throws(() => retrieveRelevantExperiences("任务", [], { limit: -1 }), /参数无效/);
});
