import { expect, test } from "bun:test";
import { pacing, TARGETS } from "./pacing";

// A slice of `bun run pacing` (seeds 0-7 of 0-49), so a later change can't quietly break balance.
test("balance: idle loses within 60 s; a realistic mover lasts 1 to 3 minutes with any upgrade order", () => {
  const result = pacing([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(result.idle.unfinished).toBe(0);
  expect(result.idle.max).toBeLessThan(TARGETS.idleMax);
  expect(result.overall.median).toBeGreaterThanOrEqual(TARGETS.overallMedian[0]);
  expect(result.overall.median).toBeLessThanOrEqual(TARGETS.overallMedian[1]);
  // Per group, so a failure names the order.
  for (const [name, s] of Object.entries(result.orders)) {
    expect({ name, median: s.median >= TARGETS.orderMedian[0] && s.median <= TARGETS.orderMedian[1] }).toEqual({ name, median: true });
    expect({ name, max: s.max <= TARGETS.runMax }).toEqual({ name, max: true });
  }
  for (const t of result.targets) expect(t).toEqual({ label: t.label, ok: true });
});
