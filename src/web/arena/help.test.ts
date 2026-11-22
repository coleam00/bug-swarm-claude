import { describe, expect, test } from "bun:test";
import type { Camera } from "./camera";
import { ARROW_MARGIN, HELP_BLINK_HZ, edgeArrow, minimapDotOn, type EdgeArrow } from "./help";

// A 1000 x 600 px screen at 1 px per unit, centred on (1200, 1200): the view is 700..1700, 900..1500.
const cam: Camera = { x: 1200, y: 1200, w: 1000, h: 600, scale: 1 };
const none = { top: 0, right: 0, bottom: 0, left: 0 };
const arrow = (): EdgeArrow => ({ x: -1, y: -1, angle: -1 });

describe("edge arrows", () => {
  test("none for a player on screen, or further than HELP_ARROW_RANGE from you", () => {
    const o = arrow();
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1690, 1490, o)).toBe(false);
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1200 + 1201, 1200, o)).toBe(false);
    expect(o).toEqual(arrow());
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1200 + 1200, 1200, o)).toBe(true);
  });

  test("with no range (the hive queen's arrow, #85): any distance off screen gets one, on screen none", () => {
    const o = arrow();
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 2390, 1200, o, Infinity)).toBe(true);
    expect(o).toEqual({ x: 1000 - ARROW_MARGIN, y: 300, angle: 0 });
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1690, 1490, o, Infinity)).toBe(false);
  });

  test("off the right or the left: at that edge, level with the centre, pointing at them", () => {
    const o = arrow();
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 2000, 1200, o)).toBe(true);
    expect(o).toEqual({ x: 1000 - ARROW_MARGIN, y: 300, angle: 0 });
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 400, 1200, o)).toBe(true);
    expect(o).toEqual({ x: ARROW_MARGIN, y: 300, angle: Math.PI });
  });

  test("off a corner: on the line from the centre, clamped to the nearer edge", () => {
    const o = arrow();
    // Down-right at 45 degrees: the bottom edge (272 px below the centre) comes first.
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1900, 1900, o)).toBe(true);
    expect(o.y).toBe(600 - ARROW_MARGIN);
    expect(o.x).toBeCloseTo(500 + (300 - ARROW_MARGIN), 9);
    expect(o.angle).toBeCloseTo(Math.PI / 4, 9);
    // Steeply up-left: the top edge.
    expect(edgeArrow(cam, 1000, 600, none, 1200, 1200, 1000, 400, o)).toBe(true);
    expect(o.y).toBe(ARROW_MARGIN);
    expect(o.x).toBeCloseTo(500 - 200 * ((300 - ARROW_MARGIN) / 800), 9);
    expect(o.angle).toBeCloseTo(Math.atan2(-800, -200), 9);
  });

  test("the safe-area insets push the arrow in", () => {
    const o = arrow();
    const notch = { top: 47, right: 40, bottom: 34, left: 30 };
    edgeArrow(cam, 1000, 600, notch, 1200, 1200, 2000, 1200, o);
    expect(o.x).toBe(1000 - 40 - ARROW_MARGIN);
    edgeArrow(cam, 1000, 600, notch, 1200, 1200, 1200, 500, o);
    expect([o.x, o.y]).toEqual([500, 47 + ARROW_MARGIN]);
  });

  test("measures range from you, not the camera, and places by the camera's scale", () => {
    const o = arrow();
    // A player 1100 units from the camera's centre but 1900 from you: no arrow.
    expect(edgeArrow(cam, 1000, 600, none, 2000, 1200, 100, 1200, o)).toBe(false);
    // Off screen at half scale: 1200 + 1100 units is 550 px right of the centre.
    expect(edgeArrow({ ...cam, scale: 0.5 }, 1000, 600, none, 1200, 1200, 2300, 1200, o)).toBe(true);
    expect(o.x).toBe(1000 - ARROW_MARGIN);
    // On screen at half scale: 1200 + 900 units is 450 px right of the centre.
    expect(edgeArrow({ ...cam, scale: 0.5 }, 1000, 600, none, 1200, 1200, 2100, 1200, o)).toBe(false);
  });
});

test("a downed player's minimap dot blinks; a player who is up shows steadily", () => {
  const half = 1 / (2 * HELP_BLINK_HZ);
  expect([minimapDotOn(true, 0), minimapDotOn(true, half), minimapDotOn(true, 2 * half)]).toEqual([true, false, true]);
  expect([minimapDotOn(false, 0), minimapDotOn(false, half)]).toEqual([true, true]);
});
