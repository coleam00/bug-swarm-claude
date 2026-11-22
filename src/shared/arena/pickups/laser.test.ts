// The review laser by stepping (#73): a shot pierces up to LASER_PIERCE bugs, never one twice.
import { describe, expect, test } from "bun:test";
import { dasher } from "../bugs/dasher";
import { SHOT_RANGE } from "../constants";
import { arenaWith, effectOf, hold, placeBug, placePickup, stepQuiet } from "../testkit";
import { LASER_PIERCE, laser } from "./laser";

/** A player at (1200, 1200) with the laser (taken from the floor in one quiet step), aiming right. */
function lasered() {
  const { a, ps } = arenaWith([1200, 1200]);
  const p = ps[0]!;
  placePickup(a, 1200, 1200, "laser");
  stepQuiet(a);
  expect(effectOf(p, "laser")).toBe(laser.durationTicks);
  return { a, p };
}

/** Fires one shot (fire held for one step), then steps until it ends; returns its fired event, its end and the kills. */
function fireOne(a: ReturnType<typeof lasered>["a"], p: ReturnType<typeof lasered>["p"]) {
  hold(p, { fire: true });
  stepQuiet(a);
  hold(p, {});
  const fired = a.events.shotsFired[0]!;
  const kills = [...a.events.kills];
  let ended = [...a.events.shotsEnded];
  for (let i = 0; i < 30 && ended.length === 0; i++) {
    stepQuiet(a);
    kills.push(...a.events.kills);
    ended = [...a.events.shotsEnded];
  }
  return { fired, ended: ended[0]!, kills };
}

describe("the review laser", () => {
  test("a shot remembers at most two bugs it hit, so LASER_PIERCE is at most 3", () => {
    expect(LASER_PIERCE).toBeGreaterThan(1);
    expect(LASER_PIERCE).toBeLessThanOrEqual(3);
  });

  test(`a shot through 4 crawlers in a line kills ${LASER_PIERCE} and ends on the last of them`, () => {
    const { a, p } = lasered();
    const line = [1300, 1330, 1360, 1390].map((x) => placeBug(a, x, 1200));
    const { fired, ended, kills } = fireOne(a, p);
    // The event the snapshot carries to every browser says it is a laser shot, so they draw the beam.
    expect(fired.laser).toBe(true);
    expect(a.shots.length).toBe(0);
    expect(kills.map((k) => k.bug)).toEqual(line.slice(0, LASER_PIERCE).map((b) => b.id));
    expect(a.bugs.map((b) => b.id)).toEqual([line[3]!.id]);
    expect(ended.hit).toBe(true);
    // It ended at the third bug's edge, short of the fourth.
    expect(ended.travelled).toBeLessThan(a.bugs[0]!.x - 1200);
    expect([p.kills, p.streak]).toEqual([LASER_PIERCE, LASER_PIERCE]);
  });

  test("it never hits one bug twice: one laser shot leaves a 2 hp dasher at 1 hp", () => {
    const { a, p } = lasered();
    // Far enough that it is still approaching or telling, not lunging, while the shot flies.
    const d = placeBug(a, 1600, 1200, "dasher");
    expect(dasher.hp).toBe(2);
    const { ended } = fireOne(a, p);
    expect(d.hp).toBe(1);
    expect(a.bugs).toContain(d);
    // It flew on through and ended at its range (not on a bug: no spark there), the streak kept.
    expect(ended.hit).toBe(false);
    expect(ended.travelled).toBeCloseTo(SHOT_RANGE, 6);
    expect(p.streak).toBe(1);
  });

  test("a normal shot ends on its first bug", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const line = [1300, 1330].map((x) => placeBug(a, x, 1200));
    const { fired, kills } = fireOne(a, p);
    expect(fired.laser).toBe(false);
    expect(kills.map((k) => k.bug)).toEqual([line[0]!.id]);
    expect(a.bugs.map((b) => b.id)).toEqual([line[1]!.id]);
  });

  test(`it lasts ${laser.durationTicks / 20} s: then a shot ends on its first bug again`, () => {
    const { a, p } = lasered();
    stepQuiet(a, laser.durationTicks - 1);
    expect(effectOf(p, "laser")).toBe(1);
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    expect(a.shots[0]!.laser).toBe(true);
    expect(a.events.shotsFired[0]!.laser).toBe(true);
    expect(effectOf(p, "laser")).toBe(0);
    stepQuiet(a, 20);
    const line = [1300, 1330].map((x) => placeBug(a, x, 1200));
    const { kills } = fireOne(a, p);
    expect(kills.map((k) => k.bug)).toEqual([line[0]!.id]);
  });
});
