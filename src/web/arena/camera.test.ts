import { expect, test } from "bun:test";
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { CAMERA_MARGIN, createCamera, followCamera, setViewport, snapCamera } from "./camera";

test("the view has release 1's area and the screen's shape", () => {
  const cam = createCamera(1440, 900);
  expect(Math.abs(cam.w * cam.h - 360_000)).toBeLessThan(1000); // arenaForViewport rounds to whole units
  expect(cam.w / cam.h).toBeCloseTo(1.6, 2);
  setViewport(cam, 390, 844);
  expect(cam.h).toBeGreaterThan(cam.w);
  expect(cam.w * cam.scale).toBeCloseTo(390, 9);
  expect(cam.h * cam.scale).toBeCloseTo(844, 9);
});

test("a screen wider than 16:9 is filled, at the robot size of a 16:9 one", () => {
  const wide = createCamera(2560, 1080);
  const sixteenNine = createCamera(1920, 1080);
  expect(wide.w * wide.scale).toBeCloseTo(2560, 9);
  expect(wide.h * wide.scale).toBeCloseTo(1080, 9);
  expect(wide.scale).toBeCloseTo(2560 / sixteenNine.w, 9);
});

test("follows a target and converges on it", () => {
  const cam = createCamera(1440, 900);
  snapCamera(cam, 1000, 1000);
  for (let i = 0; i < 120; i++) followCamera(cam, 1200, 1100, 1 / 60);
  expect(cam.x).toBeCloseTo(1200, 3);
  expect(cam.y).toBeCloseTo(1100, 3);
});

test("frame-rate independent: two 8 ms steps equal one 16 ms step", () => {
  const a = createCamera(1440, 900);
  const b = createCamera(1440, 900);
  snapCamera(a, 1000, 1000);
  snapCamera(b, 1000, 1000);
  followCamera(a, 1300, 900, 0.008);
  followCamera(a, 1300, 900, 0.008);
  followCamera(b, 1300, 900, 0.016);
  expect(Math.abs(a.x - b.x)).toBeLessThan(1e-6);
  expect(Math.abs(a.y - b.y)).toBeLessThan(1e-6);
});

test("stops at each corner with the wall and the margin in view", () => {
  const cam = createCamera(1440, 900);
  snapCamera(cam, 0, 0);
  expect(cam.x - cam.w / 2).toBeCloseTo(-CAMERA_MARGIN, 9);
  expect(cam.y - cam.h / 2).toBeCloseTo(-CAMERA_MARGIN, 9);
  for (let i = 0; i < 300; i++) followCamera(cam, WORLD_W, WORLD_H, 1 / 60);
  expect(cam.x + cam.w / 2).toBeCloseTo(WORLD_W + CAMERA_MARGIN, 3);
  expect(cam.y + cam.h / 2).toBeCloseTo(WORLD_H + CAMERA_MARGIN, 3);
});

test("a view wider than the world centres it", () => {
  const cam = { x: 0, y: 0, w: WORLD_W * 2, h: 600 };
  snapCamera(cam, 100, 100);
  expect(cam.x).toBe(WORLD_W / 2);
  expect(cam.y).toBe(300 - CAMERA_MARGIN);
});
