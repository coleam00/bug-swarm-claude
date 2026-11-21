import { expect, test } from "bun:test";
import { TICK_WINDOW_MS, createTickLog } from "./ticks";

test("no samples: no percentiles", () => {
  expect(createTickLog().percentiles(0)).toEqual({ p50: null, p95: null });
});

test("p50 and p95 over the last minute only", () => {
  const log = createTickLog();
  // An old, slow minute that must not count.
  for (let i = 0; i < 100; i++) log.record(i, 50);
  const start = 100 + TICK_WINDOW_MS;
  for (let i = 1; i <= 100; i++) log.record(start + i, i / 10); // 0.1 .. 10 ms
  expect(log.percentiles(start + 100 + TICK_WINDOW_MS - 101)).toEqual({ p50: 5, p95: 9.5 });
  expect(log.percentiles(start + 100 + TICK_WINDOW_MS + 1)).toEqual({ p50: null, p95: null });
});

test("a full ring keeps the newest samples", () => {
  const log = createTickLog(4);
  for (let i = 0; i < 6; i++) log.record(i, i);
  expect(log.percentiles(10)).toEqual({ p50: 3, p95: 5 });
});
