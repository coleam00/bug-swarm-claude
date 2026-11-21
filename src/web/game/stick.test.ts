import { describe, expect, test } from "bun:test";
import { STICK_RANGE, createStick, stickDown, stickDrive, stickKnob, stickMove, stickReset, stickUp, type StickOut } from "./stick";

const out = (): StickOut => ({ kind: "stick", dx: 0, dy: 0 });

/** A stick held by finger 1, landed at (100, 200) and dragged by (dx, dy). */
function dragged(dx: number, dy: number) {
  const s = createStick();
  stickDown(s, 1, 100, 200);
  stickMove(s, 1, 100 + dx, 200 + dy);
  return s;
}

describe("drag to movement", () => {
  test("half the range is half speed, in the drag's direction", () => {
    const o = out();
    expect(stickDrive(dragged(30, 0), o)).toBe(true);
    expect(o.dx).toBeCloseTo(0.5, 6);
    expect(o.dy).toBeCloseTo(0, 6);
  });

  test("a diagonal drag is split between the axes", () => {
    const o = out();
    expect(stickDrive(dragged(-30, 30), o)).toBe(true);
    expect(o.dx).toBeCloseTo(-30 / STICK_RANGE, 6);
    expect(o.dy).toBeCloseTo(30 / STICK_RANGE, 6);
    expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(Math.SQRT2 / 2, 6);
  });

  test("full speed at the range and no faster beyond it, keeping the direction", () => {
    const o = out();
    stickDrive(dragged(0, -STICK_RANGE), o);
    expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(1, 6);
    stickDrive(dragged(120, 160), o); // 200 px out
    expect(Math.hypot(o.dx, o.dy)).toBeCloseTo(1, 6);
    expect(o.dx).toBeCloseTo(0.6, 6);
    expect(o.dy).toBeCloseTo(0.8, 6);
  });

  test("inside the dead zone, or with no finger down, it asks for no movement", () => {
    const o = out();
    expect(stickDrive(dragged(3, 4), o)).toBe(false); // 5 px
    expect(stickDrive(dragged(0, 0), o)).toBe(false);
    expect(stickDrive(createStick(), o)).toBe(false);
  });

  test("lifting the finger stops it", () => {
    const s = dragged(40, 0);
    expect(stickUp(s, 1)).toBe(true);
    expect(stickDrive(s, out())).toBe(false);
  });
});

describe("the knob", () => {
  test("follows the finger inside the range and is held at the ring beyond it", () => {
    const k = { x: 0, y: 0 };
    stickKnob(dragged(20, -10), k);
    expect(k).toEqual({ x: 120, y: 190 });
    stickKnob(dragged(120, 160), k);
    expect(k.x).toBeCloseTo(100 + 0.6 * STICK_RANGE, 6);
    expect(k.y).toBeCloseTo(200 + 0.8 * STICK_RANGE, 6);
  });
});

describe("one finger at a time", () => {
  test("a second finger can't move the centre, steer, or let go", () => {
    const s = dragged(30, 0);
    expect(stickDown(s, 2, 10, 10)).toBe(false);
    expect(stickMove(s, 2, 500, 500)).toBe(false);
    expect(stickUp(s, 2)).toBe(false);
    expect(s).toEqual({ id: 1, active: true, cx: 100, cy: 200, x: 130, y: 200 });
    expect(stickUp(s, 1)).toBe(true);
    expect(stickDown(s, 2, 10, 10)).toBe(true); // free again: the next finger takes it
    expect(s.cx).toBe(10);
  });

  test("after a reset the old finger's moves do nothing until a new touch lands", () => {
    const s = dragged(30, 0);
    stickReset(s);
    expect(stickMove(s, 1, 200, 200)).toBe(false);
    expect(stickDrive(s, out())).toBe(false);
    expect(stickDown(s, 1, 50, 50)).toBe(true);
    expect(s).toEqual({ id: 1, active: true, cx: 50, cy: 50, x: 50, y: 50 });
  });
});
