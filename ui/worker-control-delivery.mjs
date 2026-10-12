export async function dispatchControlEvent({ dispatch, ensureRunning, event } = {}) {
  if (typeof dispatch !== "function" || typeof ensureRunning !== "function" || !event || typeof event !== "object") {
    throw new TypeError("Worker control delivery requires an event, dispatch function, and start function");
  }

  let result = await dispatch(event);
  if (!result?.accepted && result?.state === "stopped") {
    await ensureRunning();
    result = await dispatch(event);
  }
  return result;
}
