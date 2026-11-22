import { expect, test } from "bun:test";
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { CAMERA_MARGIN } from "./camera";
import { DRIFT_HOLD_S, DRIFT_MAX_SPEED, createDrift, pickFocus, stepDrift } from "./drift";

/** Bugs at these spots. */
function bugsAt(spots: [number, number][]) {
  return { x: spots.map((s) => s[0]), y: spots.map((s) => s[1]), count: spots.length };
}
const cam = (x = WORLD_W / 2, y = WORLD_H / 2) => ({ x, y, w: 800, h: 450 });

test("the focus is the robot with the most bugs near it, a different one from the last when it can", () => {
  const robots = [
    { id: 1, x: 500, y: 500 },
    { id: 2, x: 1800, y: 1800 },
  ];
  const bugs = bugsAt([
    [520, 500],
    [1810, 1800],
    [1790, 1810],
    [1800, 1500],
  ]);
  const d = createDrift();
  pickFocus(d, robots, 2, bugs);
  expect(d.id).toBe(2);
  pickFocus(d, robots, 2, bugs);
  expect(d.id).toBe(1);
  // Alone, it keeps the same robot; nobody in a life: the world's centre.
  pickFocus(d, robots, 1, bugs);
  expect(d.id).toBe(1);
  pickFocus(d, robots, 0, bugs);
  expect([d.id, d.x, d.y]).toEqual([0, WORLD_W / 2, WORLD_H / 2]);
});

test("the focus holds for DRIFT_HOLD_S, following its robot, before the next pick", () => {
  const robots = [
    { id: 1, x: 600, y: 600 },
    { id: 2, x: 1600, y: 1600 },
  ];
  const quiet = bugsAt([]);
  const d = createDrift();
  const c = cam();
  stepDrift(d, c, robots, 2, quiet, 1 / 60);
  expect(d.id).toBe(1);
  // Robot 2 gets busy at once: the camera stays on robot 1 until the hold is up, following it.
  const busy = bugsAt([[1600, 1610]]);
  for (let f = 0; f < 60 * (DRIFT_HOLD_S - 0.5); f++) {
    robots[0]!.x += 1;
    stepDrift(d, c, robots, 2, busy, 1 / 60);
  }
  expect(d.id).toBe(1);
  expect(d.x).toBe(robots[0]!.x);
  for (let f = 0; f < 60; f++) stepDrift(d, c, robots, 2, busy, 1 / 60);
  expect(d.id).toBe(2);
});

test("the camera never moves faster than DRIFT_MAX_SPEED, and stays inside the world's bounds", () => {
  const robots = [{ id: 1, x: 0, y: 0 }];
  const d = createDrift();
  const c = cam(WORLD_W - 400, WORLD_H - 225);
  let speedMax = 0;
  for (let f = 0; f < 60 * 30; f++) {
    const x = c.x;
    const y = c.y;
    stepDrift(d, c, robots, 1, bugsAt([]), 1 / 60);
    speedMax = Math.max(speedMax, Math.hypot(c.x - x, c.y - y) * 60);
  }
  expect(speedMax).toBeLessThanOrEqual(DRIFT_MAX_SPEED + 1e-6);
  expect(speedMax).toBeGreaterThan(DRIFT_MAX_SPEED * 0.9);
  // Parked at the corner: the view's edge stops at the wall plus the margin.
  expect(c.x).toBeCloseTo(c.w / 2 - CAMERA_MARGIN, 0);
  expect(c.y).toBeCloseTo(c.h / 2 - CAMERA_MARGIN, 0);
});
