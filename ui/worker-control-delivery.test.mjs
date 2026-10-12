import assert from "node:assert/strict";
import test from "node:test";
import { dispatchControlEvent } from "./worker-control-delivery.mjs";

test("a stopped Worker is started before retrying the same durable control event", async () => {
  const event = { type: "goal.control", command: "resume", eventId: "control-retry-1" };
  const deliveries = [];
  let starts = 0;
  const result = await dispatchControlEvent({
    event,
    ensureRunning: async () => { starts += 1; },
    dispatch: async value => {
      deliveries.push(value);
      return deliveries.length === 1
        ? { accepted: false, state: "stopped" }
        : { accepted: true, state: "running" };
    },
  });

  assert.equal(starts, 1);
  assert.equal(deliveries.length, 2);
  assert.equal(deliveries[0], event);
  assert.equal(deliveries[1], event);
  assert.equal(result.accepted, true);
});

test("a rejected control for another reason is not retried as if it were stopped", async () => {
  let starts = 0;
  let deliveries = 0;
  const result = await dispatchControlEvent({
    event: { type: "goal.control", command: "resume", eventId: "control-full-1" },
    ensureRunning: async () => { starts += 1; },
    dispatch: async () => { deliveries += 1; return { accepted: false, state: "queue-full" }; },
  });

  assert.equal(starts, 0);
  assert.equal(deliveries, 1);
  assert.equal(result.state, "queue-full");
});
