import assert from "node:assert/strict";
import test from "node:test";

import { WordstatError } from "../src/errors.js";
import { delay, RequestLimiter } from "../src/rate-limiter.js";

test("delay reacts immediately to cancellation", async () => {
  const controller = new AbortController();
  const pending = delay(60_000, controller.signal);
  controller.abort();
  await assert.rejects(
    pending,
    (error: unknown) => error instanceof WordstatError && error.code === "CANCELLED",
  );
});

test("concurrency waiter can be cancelled without executing its operation", async () => {
  const limiter = new RequestLimiter(1, 100, 100);
  let releaseFirst: (() => void) | undefined;
  const first = limiter.run(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = resolve;
      }),
    new AbortController().signal,
  );
  let secondExecuted = false;
  const controller = new AbortController();
  const second = limiter.run(async () => {
    secondExecuted = true;
  }, controller.signal);
  controller.abort();
  await assert.rejects(
    second,
    (error: unknown) => error instanceof WordstatError && error.code === "CANCELLED",
  );
  assert.equal(secondExecuted, false);
  releaseFirst?.();
  await first;
});

test("RPS limiter spaces started operations", async () => {
  const limiter = new RequestLimiter(2, 1, 100);
  const starts: number[] = [];
  const signal = new AbortController().signal;
  await Promise.all([
    limiter.run(async () => {
      starts.push(Date.now());
    }, signal),
    limiter.run(async () => {
      starts.push(Date.now());
    }, signal),
  ]);
  assert.equal(starts.length, 2);
  assert.ok(starts[1]! - starts[0]! >= 900);
});

test("disabled hourly limiting does not retain request timestamps", async () => {
  const limiter = new RequestLimiter(4, 100, 0);
  await Promise.all(
    Array.from({ length: 50 }, async () =>
      limiter.run(async () => undefined, new AbortController().signal),
    ),
  );
  const hourStarts = Reflect.get(limiter, "hourStarts") as unknown[];
  assert.equal(hourStarts.length, 0);
  assert.equal(limiter.hourlyRemaining(), null);
});
