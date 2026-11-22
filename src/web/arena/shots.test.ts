import { describe, expect, test } from "bun:test";
import { DT, SHOT_RANGE, SHOT_SPEED } from "../../shared/arena/constants";
import { addShot, createKillQueue, createShots, drainKills, endShot, pruneShots, queueKill, shotTravel } from "./shots";

const STEP = SHOT_SPEED * DT;
const nobody = () => false;

describe("shots drawn by the browser", () => {
  test("a shot flies from the barrel at the server's speed, and between ticks", () => {
    const s = createShots();
    addShot(s, 5, 1, 100, 200, 0, 10);
    expect(shotTravel(s, 0, 8)).toBe(-1);
    expect(shotTravel(s, 0, 9)).toBe(0);
    expect(shotTravel(s, 0, 9.5)).toBeCloseTo(STEP / 2, 9);
    expect(shotTravel(s, 0, 10)).toBe(STEP);
    expect(shotTravel(s, 0, 12)).toBe(STEP * 3);
    expect(shotTravel(s, 0, 100)).toBe(SHOT_RANGE);
  });

  test("an ended shot stops where it ended, then is let go with a spark if it hit", () => {
    const s = createShots();
    addShot(s, 5, 1, 100, 200, 0, 10);
    addShot(s, 6, 1, 100, 200, Math.PI / 2, 10);
    endShot(s, 5, 1, 70, 11);
    endShot(s, 6, 0, SHOT_RANGE, 25);
    expect(shotTravel(s, 0, 10.9)).toBeCloseTo(70, 3);
    const sparks: number[][] = [];
    pruneShots(s, 10.9, nobody, false, (x, y) => sparks.push([x, y]));
    expect(s.live).toBe(2);
    pruneShots(s, 11, nobody, false, (x, y) => sparks.push([x, y]));
    expect(sparks).toEqual([[170, 200]]);
    expect(shotTravel(s, 0, 11)).toBe(-1);
    expect(s.live).toBe(1);
    pruneShots(s, 25, nobody, false, (x, y) => sparks.push([x, y]));
    expect(s.live).toBe(0);
    expect(sparks.length).toBe(1);
  });

  test("a shot a shell stopped is let go with its spark marked blocked (#80)", () => {
    const s = createShots();
    addShot(s, 1, 1, 0, 0, 0, 10);
    addShot(s, 2, 1, 0, 0, 0, 10);
    endShot(s, 1, 2, 40, 11);
    endShot(s, 2, 1, 60, 11);
    const sparks: [number, boolean][] = [];
    pruneShots(s, 11, nobody, false, (x, _y, blocked) => sparks.push([x, blocked]));
    expect(sparks).toEqual([
      [40, true],
      [60, false],
    ]);
  });

  test("your shots and everyone else's are let go on their own clocks", () => {
    const s = createShots();
    addShot(s, 1, 7, 0, 0, 0, 10);
    addShot(s, 2, 8, 0, 0, 0, 10);
    endShot(s, 1, 0, 90, 11);
    endShot(s, 2, 0, 90, 11);
    const mine = (owner: number) => owner === 7;
    pruneShots(s, 12, mine, true, () => {});
    expect(s.live).toBe(1);
    pruneShots(s, 12, mine, false, () => {});
    expect(s.live).toBe(0);
  });

  test("a full pool reuses the oldest slot", () => {
    const s = createShots(4);
    for (let id = 10; id < 16; id++) addShot(s, id, 1, 0, 0, 0, 50);
    expect(s.live).toBe(4);
    expect([...s.id]).toEqual([14, 15, 12, 13]);
    // The overwritten shots' ends are ignored.
    endShot(s, 10, 1, 5, 51);
    expect([...s.endTick].every((t) => t === -1)).toBe(true);
  });
});

describe("kills", () => {
  test("a kill shows once the drawing time reaches its tick, on its owner's clock", () => {
    const q = createKillQueue();
    queueKill(q, 20, 5, 6, 15, 3);
    queueKill(q, 22, 7, 8, 10, 4);
    const shown: number[][] = [];
    const mine = (by: number) => by === 3;
    drainKills(q, 19.5, mine, true, (x, y, p, by) => shown.push([x, y, p, by]));
    drainKills(q, 21, mine, false, (x, y, p, by) => shown.push([x, y, p, by]));
    expect(shown).toEqual([]);
    drainKills(q, 20, mine, true, (x, y, p, by) => shown.push([x, y, p, by]));
    drainKills(q, 22, mine, false, (x, y, p, by) => shown.push([x, y, p, by]));
    expect(shown).toEqual([
      [5, 6, 15, 3],
      [7, 8, 10, 4],
    ]);
    expect(q.live).toBe(0);
  });
});

test("a review laser shot (#73) is marked in its slot, and a slot reused by a normal shot is not", () => {
  const s = createShots(1);
  addShot(s, 1, 1, 0, 0, 0, 10, true);
  expect(s.laser[0]).toBe(1);
  addShot(s, 2, 1, 0, 0, 0, 11);
  expect(s.laser[0]).toBe(0);
});
