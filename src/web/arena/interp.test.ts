import { describe, expect, test } from "bun:test";
import { TICK_MS } from "../../shared/arena/constants";
import type { SnapshotPlayer } from "../../shared/arena/protocol";
import { DELAY_TICKS, INTERP_BUFFER, createInterp, pushSnapshot, renderTick, sample } from "./interp";

const row = (id: number, x: number, y: number, aim = 0): SnapshotPlayer => [id, x, y, 0, 0, aim];
const out = () => ({ x: 0, y: 0, aim: 0 });

describe("sampling", () => {
  test("halfway between two snapshots is halfway between their positions", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [row(1, 100, 200)], 0);
    pushSnapshot(it, 11, [row(1, 110, 180)], 50);
    const o = out();
    expect(sample(it, 1, 10.5, o)).toBe(true);
    expect(o).toEqual({ x: 105, y: 190, aim: 0 });
  });

  test("aim turns along the shorter arc, across the -pi/pi seam", () => {
    const it = createInterp();
    pushSnapshot(it, 1, [row(1, 0, 0, 3.0)], 0);
    pushSnapshot(it, 2, [row(1, 0, 0, -3.0)], 50);
    const o = out();
    sample(it, 1, 1.5, o);
    expect(Math.abs(Math.abs(o.aim) - Math.PI)).toBeLessThan(1e-9);
  });

  test("starved of snapshots, a player holds at the newest; before the buffer, at the oldest", () => {
    const it = createInterp();
    pushSnapshot(it, 5, [row(1, 0, 0)], 0);
    pushSnapshot(it, 6, [row(1, 10, 0)], 50);
    const o = out();
    sample(it, 1, 9, o);
    expect(o.x).toBe(10);
    sample(it, 1, 2, o);
    expect(o.x).toBe(0);
  });

  test("a player missing from the newest snapshot is gone; a new one appears at once", () => {
    const it = createInterp();
    pushSnapshot(it, 1, [row(1, 0, 0), row(2, 5, 5)], 0);
    pushSnapshot(it, 2, [row(2, 6, 6), row(3, 50, 50)], 50);
    const o = out();
    expect(sample(it, 1, 1.5, o)).toBe(false);
    expect(sample(it, 3, 1.5, o)).toBe(true);
    expect(o.x).toBe(50);
    expect(sample(it, 2, 1.5, o)).toBe(true);
    expect(o.x).toBe(5.5);
  });

  test("old and repeated snapshots are ignored, and the buffer is bounded", () => {
    const it = createInterp();
    for (let t = 1; t <= 30; t++) pushSnapshot(it, t, [row(1, t, 0)], t * TICK_MS);
    pushSnapshot(it, 12, [row(1, -1, 0)], 31 * TICK_MS);
    expect(it.frames.length).toBe(INTERP_BUFFER);
    expect(it.frames[0]!.tick).toBe(21);
  });
});

describe("the tick clock", () => {
  test("draws DELAY_TICKS behind the newest snapshot as it arrives", () => {
    const it = createInterp();
    pushSnapshot(it, 100, [row(1, 0, 0)], 10_000);
    expect(renderTick(it, 10_000)).toBe(100 - DELAY_TICKS);
    expect(renderTick(it, 10_025)).toBe(100.5 - DELAY_TICKS);
  });

  test("never goes backward, even when a snapshot arrives early", () => {
    const it = createInterp();
    pushSnapshot(it, 100, [], 10_000);
    const a = renderTick(it, 10_040);
    pushSnapshot(it, 101, [], 10_010); // early: pulls the estimate back a little
    expect(renderTick(it, 10_041)).toBeGreaterThanOrEqual(a);
  });

  test("a clock far off (a tab back from the background) resets", () => {
    const it = createInterp();
    pushSnapshot(it, 100, [], 10_000);
    pushSnapshot(it, 300, [], 12_000); // 200 ticks later, 2 s later: 160 ticks off
    expect(renderTick(it, 12_000)).toBe(300 - DELAY_TICKS);
  });
});
