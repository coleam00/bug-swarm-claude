import { describe, expect, test } from "bun:test";
import { TICK_MS } from "../../shared/arena/constants";
import type { SnapshotPlayer } from "../../shared/arena/protocol";
import { DELAY_TICKS, INTERP_BUFFER, bugSpan, createInterp, downAt, newestDown, pushSnapshot, renderTick, sample, type BugSpan } from "./interp";

const row = (id: number, x: number, y: number, aim = 0, dash: 0 | 1 = 0, fx = 0): SnapshotPlayer => [id, x, y, 0, 0, aim, 1, 0, dash, 0, fx];
const out = () => ({ x: 0, y: 0, aim: 0, alive: false, inv: false, dash: false, prot: false, fx: 0 });

describe("sampling", () => {
  test("a player's pickup effects (#73) come from the snapshot it is drawn from, and so does the floor", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [row(1, 100, 200, 0, 0, 0)], 0, [], [], []);
    pushSnapshot(it, 11, [row(1, 110, 180, 0, 0, 3)], 50, [], [], [[4, 1, 500, 600, 200]]);
    const o = out();
    sample(it, 1, 10.5, o);
    expect(o.fx).toBe(0);
    sample(it, 1, 11, o);
    expect(o.fx).toBe(3);
    expect(bugSpan(it, 11, { from: null, to: null, t: 0 }).from!.f).toEqual([[4, 1, 500, 600, 200]]);
  });

  test("halfway between two snapshots is halfway between their positions", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [row(1, 100, 200)], 0);
    pushSnapshot(it, 11, [row(1, 110, 180)], 50);
    const o = out();
    expect(sample(it, 1, 10.5, o)).toBe(true);
    expect(o).toEqual({ x: 105, y: 190, aim: 0, alive: true, inv: false, dash: false, prot: false, fx: 0 });
  });

  test("aim turns along the shorter arc, across the -pi/pi seam", () => {
    const it = createInterp();
    pushSnapshot(it, 1, [row(1, 0, 0, 3.0)], 0);
    pushSnapshot(it, 2, [row(1, 0, 0, -3.0)], 50);
    pushSnapshot(it, 3, [row(1, 0, 0, 3.0)], 100);
    const o = out();
    sample(it, 1, 1.5, o);
    expect(Math.abs(Math.abs(o.aim) - Math.PI)).toBeLessThan(1e-9);
    sample(it, 1, 2.5, o); // and back the other way
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

  test("never goes backward, even when a late snapshot pulls the estimate back", () => {
    const it = createInterp();
    pushSnapshot(it, 100, [], 10_000);
    const a = renderTick(it, 10_040);
    pushSnapshot(it, 101, [], 10_300); // late: the server seems further behind than estimated
    expect(renderTick(it, 10_041)).toBeGreaterThanOrEqual(a);
  });

  test("a clock far off (a tab back from the background) resets", () => {
    const it = createInterp();
    pushSnapshot(it, 100, [], 10_000);
    pushSnapshot(it, 300, [], 12_000); // 200 ticks later, 2 s later: 160 ticks off
    expect(renderTick(it, 12_000)).toBe(300 - DELAY_TICKS);
  });
});

describe("lives and bugs", () => {
  test("a dash shows from the moment the robot starts to move toward its first dashing snapshot", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [row(1, 100, 100)], 0);
    pushSnapshot(it, 11, [row(1, 173, 100, 0, 1)], 50);
    pushSnapshot(it, 12, [row(1, 247, 100, 0, 0)], 100);
    const o = out();
    sample(it, 1, 10, o);
    expect(o.dash).toBe(false);
    sample(it, 1, 10.2, o);
    expect(o.dash).toBe(true);
    sample(it, 1, 11.5, o);
    expect(o.dash).toBe(false);
  });

  test("a respawn does not slide across the map: the out snapshot holds until the new one", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [[1, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0]], 0);
    pushSnapshot(it, 11, [[1, 2000, 2000, 0, 0, 0, 1, 1, 0, 1, 0]], 50);
    const o = out();
    sample(it, 1, 10.9, o);
    expect([o.x, o.alive]).toEqual([100, false]);
    sample(it, 1, 11, o);
    expect([o.x, o.alive, o.inv, o.prot]).toEqual([2000, true, true, true]);
  });

  test("bugs are drawn from the snapshot at or before the drawing time, moving toward the next", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [], 0, [
      [1, 0, 100, 100],
      [2, 0, 500, 500],
    ]);
    pushSnapshot(it, 11, [], 50, [[1, 0, 108, 100]]);
    const span: BugSpan = { from: null, to: null, t: 0 };
    bugSpan(it, 10.5, span);
    expect(span.from!.tick).toBe(10);
    expect(span.to!.tick).toBe(11);
    expect(span.t).toBe(0.5);
    // Bug 2 died by tick 11, but is still drawn at 10.5; it is gone from tick 11 on.
    expect(span.from!.b.map((b) => b[0])).toEqual([1, 2]);
    expect(span.to!.bi.get(1)![2]).toBe(108);
    expect(span.to!.bi.has(2)).toBe(false);
    bugSpan(it, 11.2, span);
    expect(span.from!.b.map((b) => b[0])).toEqual([1]);
    expect(span.to).toBeNull();
  });
});

describe("downs", () => {
  test("a down row is read from the frame at or before the drawing time, like the robot's other states", () => {
    const it = createInterp();
    pushSnapshot(it, 10, [row(1, 0, 0)], 0, [], []);
    pushSnapshot(it, 11, [row(1, 0, 0)], 50, [], [[1, 9.95, 0, 0]]);
    pushSnapshot(it, 12, [row(1, 0, 0)], 100, [], [[1, 9.9, 2, 0.03]]);
    expect(downAt(it, 1, 10.9)).toBeUndefined();
    expect(downAt(it, 1, 11)).toEqual([1, 9.95, 0, 0]);
    expect(downAt(it, 1, 11.5)).toEqual([1, 9.95, 0, 0]);
    expect(downAt(it, 1, 14)).toEqual([1, 9.9, 2, 0.03]);
    expect(downAt(it, 1, 2)).toBeUndefined(); // before the buffer: the oldest
    expect(downAt(it, 2, 12)).toBeUndefined();
  });

  test("your own down row is the newest snapshot's", () => {
    const it = createInterp();
    expect(newestDown(it, 1)).toBeUndefined();
    pushSnapshot(it, 10, [row(1, 0, 0)], 0, [], [[1, 5, 0, 0]]);
    pushSnapshot(it, 11, [row(1, 0, 0)], 50);
    expect(newestDown(it, 1)).toBeUndefined();
    pushSnapshot(it, 12, [row(1, 0, 0)], 100, [], [[1, 4.9, 0, 0]]);
    expect(newestDown(it, 1)).toEqual([1, 4.9, 0, 0]);
  });
});
