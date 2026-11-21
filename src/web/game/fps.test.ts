import { expect, test } from "bun:test";
import { createFpsMeter, tickFps } from "./fps";

function ticks(m: ReturnType<typeof createFpsMeter>, n: number, dt: number): number {
  let updates = 0;
  for (let i = 0; i < n; i++) if (tickFps(m, dt)) updates++;
  return updates;
}

test("frames over each half second: 60 a second at 1/60 s, 30 at 1/30 s", () => {
  const m = createFpsMeter();
  expect(ticks(m, 60, 1 / 60)).toBe(2);
  expect(m.fps).toBeCloseTo(60, 6);
  expect(ticks(m, 30, 1 / 30)).toBe(2);
  expect(m.fps).toBeCloseTo(30, 6);
});

test("no reading before the first window fills", () => {
  const m = createFpsMeter();
  expect(ticks(m, 29, 1 / 60)).toBe(0);
  expect(m.fps).toBe(0);
  expect(tickFps(m, 1 / 60)).toBe(true);
  expect(m.fps).toBeCloseTo(60, 6);
});

test("a long frame is counted at its real length", () => {
  const m = createFpsMeter();
  expect(tickFps(m, 1)).toBe(true);
  expect(m.fps).toBeCloseTo(1, 6);
});
