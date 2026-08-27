"use strict";

// Bounded-concurrency async pool — the Node stand-in for Python's
// ThreadPoolExecutor(as_completed). Runs `worker(item, index)` over every item
// with at most `concurrency` in flight. `onResult(value, item, index)` is
// awaited as each worker resolves; `onError(err, item, index)` handles a
// rejected worker (so one failure never aborts the batch). Both are optional.
async function runPool(items, worker, concurrency, onResult, onError) {
  const list = Array.from(items);
  let next = 0;
  const limit = Math.max(1, concurrency | 0);

  async function drain() {
    while (next < list.length) {
      const index = next++;
      const item = list[index];
      try {
        const value = await worker(item, index);
        if (onResult) await onResult(value, item, index);
      } catch (err) {
        if (onError) await onError(err, item, index);
        else throw err;
      }
    }
  }

  const runners = [];
  for (let i = 0; i < Math.min(limit, list.length); i++) runners.push(drain());
  await Promise.all(runners);
}

module.exports = { runPool };
