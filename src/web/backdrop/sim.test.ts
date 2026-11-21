import { expect, test } from "bun:test";
import { BUG_KINDS, ROBOT_RADIUS } from "../game/config";
import { BUG_LOOK_IDS, BUG_LOOKS } from "../game/look";
import {
  BUGS_MAX,
  BUGS_TARGET,
  LANE_BOB,
  MAX_STEP,
  ROBOTS,
  SHOTS_MAX,
  backdropWorld,
  createBackdrop,
  laneY,
  resizeBackdrop,
  stepBackdrop,
  type Backdrop,
} from "./sim";

const STEP = 1 / 60;
const noPop = () => {};
const pools = (b: Backdrop) =>
  [b.robotX, b.robotY, b.robotAim, b.bugX, b.bugY, b.bugHeading, b.bugAlive, b.bugLook, b.shotX, b.shotY, b.shotLife, b.shotTeam].map((a) => Array.from(a));

test("the backdrop's world has the arena's area at the screen's own aspect", () => {
  const portrait = backdropWorld(390, 844);
  const landscape = backdropWorld(1440, 900);
  expect(portrait.w / portrait.h).toBeCloseTo(390 / 844);
  expect(landscape.w / landscape.h).toBeCloseTo(1440 / 900);
  expect(portrait.w * portrait.h).toBeCloseTo(landscape.w * landscape.h);
});

test("the same seed and steps give the same backdrop", () => {
  const dts = [STEP, 0.02, 0.008, 0.05, STEP, 0.03];
  const run = () => {
    const b = createBackdrop(51, backdropWorld(390, 844));
    for (let n = 0; n < 600; n++) stepBackdrop(b, dts[n % dts.length]!, noPop);
    return b;
  };
  const a = run();
  const b = run();
  expect(pools(a)).toEqual(pools(b));
  expect(a.pops).toBe(b.pops);
  expect(a.pops).toBeGreaterThan(0);
  expect(pools(createBackdrop(52, backdropWorld(390, 844)))).not.toEqual(pools(createBackdrop(51, backdropWorld(390, 844))));
});

test("30 minutes open on a stream: bugs stay pooled, robots keep their lanes, pops keep coming", () => {
  const b = createBackdrop(51, backdropWorld(1440, 900));
  const lengths = pools(b).map((p) => p.length);
  const { w, h } = b.world;
  let windowPops = 0;
  let windowStart = 0;
  let minLive = Infinity;
  let maxLive = 0;
  const shotsSeen = new Set<number>();
  for (let n = 1; n <= 30 * 60 * 60; n++) {
    stepBackdrop(b, STEP, () => windowPops++);
    if (n > 60 * 5) {
      minLive = Math.min(minLive, b.bugsLive);
      maxLive = Math.max(maxLive, b.bugsLive);
    }
    for (let i = 0; i < ROBOTS; i++) {
      const x = b.robotX[i]!;
      const y = b.robotY[i]!;
      if (x < 0 || x > w || Math.abs(y - laneY(b, i)) > h * LANE_BOB + 1e-9) throw new Error(`robot ${i} left its lane at step ${n}`);
    }
    for (let s = 0; s < SHOTS_MAX; s++) if (b.shotLife[s]! > 0) shotsSeen.add(b.shotTeam[s]!);
    if (n % (10 * 60) === 0) {
      if (windowPops === 0) throw new Error(`no pops in the 10 s up to ${n / 60} s`);
      windowPops = 0;
      windowStart = n;
    }
  }
  expect(windowStart).toBe(30 * 60 * 60);
  expect(minLive).toBeGreaterThan(0);
  expect(maxLive).toBeLessThanOrEqual(BUGS_MAX);
  expect(b.bugsLive).toBe(Array.from(b.bugAlive).filter(Boolean).length);
  expect(pools(b).map((p) => p.length)).toEqual(lengths);
  // Both teams' robots fire.
  expect([...shotsSeen].sort()).toEqual([0, 1]);
});

test("one hit pops one bug, where it was, in its look's glow", () => {
  const b = createBackdrop(51, backdropWorld(1280, 720));
  // One bug, stood still in front of robot 0, and nothing else.
  b.bugAlive.fill(0);
  b.bugsLive = 0;
  b.spawnClock = -1e9;
  const j = 3;
  const look = 1;
  b.bugAlive[j] = 1;
  b.bugsLive = 1;
  b.bugLook[j] = look;
  b.bugSpeed[j] = 0;
  b.robotCooldown.fill(1e9);
  b.robotCooldown[0] = 0;
  const x = b.robotX[0]! + 120;
  const y = b.robotY[0]!;
  b.bugX[j] = x;
  b.bugY[j] = y;
  const popped: [number, number, number][] = [];
  for (let n = 0; n < 60 && popped.length === 0; n++) stepBackdrop(b, STEP, (px, py, glow) => popped.push([px, py, glow]));
  expect(popped).toHaveLength(1);
  expect(popped[0]![0]).toBeCloseTo(x, 0);
  expect(popped[0]![1]).toBeCloseTo(y, 0);
  expect(popped[0]![2]).toBe(BUG_LOOKS[BUG_LOOK_IDS[look]!].glow);
  expect(b.bugsLive).toBe(0);
  expect(b.bugAlive[j]).toBe(0);
});

test("a bug that reaches a robot pops and the robot carries on", () => {
  const b = createBackdrop(51, backdropWorld(1280, 720));
  b.bugAlive.fill(0);
  b.bugsLive = 1;
  b.spawnClock = -1e9;
  b.robotCooldown.fill(1e9);
  b.bugAlive[0] = 1;
  b.bugX[0] = b.robotX[2]! + ROBOT_RADIUS;
  b.bugY[0] = b.robotY[2]!;
  let pops = 0;
  stepBackdrop(b, STEP, () => pops++);
  expect(pops).toBe(1);
  expect(b.bugsLive).toBe(0);
});

test("a long gap moves things no further than one MAX_STEP", () => {
  const a = createBackdrop(51, backdropWorld(390, 844));
  const b = createBackdrop(51, backdropWorld(390, 844));
  stepBackdrop(a, 10, noPop);
  stepBackdrop(b, MAX_STEP, noPop);
  expect(pools(a)).toEqual(pools(b));
  expect(a.time).toBe(MAX_STEP);
  stepBackdrop(a, -1, noPop);
  expect(a.time).toBe(MAX_STEP);
});

test("a resize keeps every bug, shot and robot inside the new world", () => {
  const b = createBackdrop(51, backdropWorld(1440, 900));
  for (let n = 0; n < 600; n++) stepBackdrop(b, STEP, noPop);
  const world = backdropWorld(360, 640);
  resizeBackdrop(b, world);
  const inside = (x: number, y: number) => x >= 0 && x <= world.w && y >= 0 && y <= world.h;
  for (let j = 0; j < BUGS_MAX; j++) if (b.bugAlive[j]) expect(inside(b.bugX[j]!, b.bugY[j]!)).toBe(true);
  for (let s = 0; s < SHOTS_MAX; s++) if (b.shotLife[s]! > 0) expect(inside(b.shotX[s]!, b.shotY[s]!)).toBe(true);
  for (let i = 0; i < ROBOTS; i++) expect(inside(b.robotX[i]!, b.robotY[i]!)).toBe(true);
  for (let n = 0; n < 600; n++) stepBackdrop(b, STEP, noPop);
  for (let j = 0; j < BUGS_MAX; j++) if (b.bugAlive[j]) expect(inside(b.bugX[j]!, b.bugY[j]!)).toBe(true);
});

test("it starts with bugs on screen and every bug is one of the game's kinds", () => {
  const b = createBackdrop(51, backdropWorld(390, 844));
  expect(b.bugsLive).toBe(BUGS_TARGET);
  for (let j = 0; j < BUGS_MAX; j++) if (b.bugAlive[j]) expect(BUG_KINDS[b.bugLook[j]!]).toBeDefined();
});
