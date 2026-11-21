import { describe, expect, test } from "bun:test";
import { STICK_RANGE } from "../game/stick";
import { createControls, pointerDown, pointerMove, pointerUp, readControls, releaseAll } from "./controls";

const out = () => ({ mx: 0, my: 0, aim: 0 });

describe("keyboard and mouse", () => {
  test("WASD and arrows move; the mouse aims from your robot on screen", () => {
    const c = createControls(1440);
    const o = out();
    c.keys.add("KeyD");
    c.keys.add("ArrowUp");
    pointerMove(c, "mouse", 1, 700, 300);
    readControls(c, 700, 450, o);
    expect([o.mx, o.my]).toEqual([1, -1]);
    expect(o.aim).toBeCloseTo(-Math.PI / 2, 12);
    c.keys.clear();
    readControls(c, 700, 450, o);
    expect([o.mx, o.my]).toEqual([0, 0]);
  });

  test("a finger takes the aim from the mouse", () => {
    const c = createControls(1440);
    const o = out();
    pointerMove(c, "mouse", 1, 800, 450);
    readControls(c, 700, 450, o);
    expect(o.aim).toBe(0);
    pointerDown(c, "touch", 2, 300, 300);
    // Your robot moved on screen: the idle mouse must not re-aim (it would give pi/4).
    readControls(c, 700, 350, o);
    expect(o.aim).toBe(0);
  });
});

describe("twin sticks", () => {
  test("a finger on the left half moves, one on the right half aims, both at once", () => {
    const c = createControls(844);
    const o = out();
    pointerDown(c, "touch", 1, 150, 250);
    pointerDown(c, "touch", 2, 650, 200);
    pointerMove(c, "touch", 1, 150 + STICK_RANGE, 250); // full right
    pointerMove(c, "touch", 2, 650, 200 + 40); // aim straight down
    readControls(c, 422, 195, o);
    expect(o.mx).toBeCloseTo(1, 12);
    expect(o.my).toBeCloseTo(0, 12);
    expect(o.aim).toBeCloseTo(Math.PI / 2, 12);
    expect(c.touched).toBe(true);
  });

  test("a half drag moves at half speed; inside the dead zone the aim holds", () => {
    const c = createControls(844);
    const o = out();
    pointerDown(c, "touch", 1, 100, 200);
    pointerMove(c, "touch", 1, 100, 200 - STICK_RANGE / 2);
    pointerDown(c, "touch", 2, 600, 200);
    pointerMove(c, "touch", 2, 600 - 30, 200);
    readControls(c, 0, 0, o);
    expect(o.my).toBeCloseTo(-0.5, 12);
    expect(o.aim).toBeCloseTo(Math.PI, 12);
    pointerMove(c, "touch", 2, 600 + 2, 200); // back inside the dead zone
    readControls(c, 0, 0, o);
    expect(o.aim).toBeCloseTo(Math.PI, 12);
  });

  test("a second finger on a side already held is ignored", () => {
    const c = createControls(844);
    const o = out();
    pointerDown(c, "touch", 1, 100, 200);
    pointerDown(c, "touch", 3, 200, 100); // second finger, left half
    pointerMove(c, "touch", 3, 200 + STICK_RANGE, 100);
    readControls(c, 0, 0, o);
    expect([o.mx, o.my]).toEqual([0, 0]);
    pointerUp(c, "touch", 3);
    expect(c.move.active).toBe(true);
    pointerUp(c, "touch", 1);
    expect(c.move.active).toBe(false);
  });

  test("lifting the move finger stops; the aim finger lifting keeps the aim", () => {
    const c = createControls(844);
    const o = out();
    pointerDown(c, "touch", 1, 100, 200);
    pointerMove(c, "touch", 1, 100 + STICK_RANGE, 200);
    pointerDown(c, "touch", 2, 600, 200);
    pointerMove(c, "touch", 2, 600, 200 - 40);
    readControls(c, 0, 0, o);
    pointerUp(c, "touch", 1);
    pointerUp(c, "touch", 2);
    readControls(c, 0, 0, o);
    expect([o.mx, o.my]).toEqual([0, 0]);
    expect(o.aim).toBeCloseTo(-Math.PI / 2, 12);
  });

  test("releaseAll lets go of keys and both sticks", () => {
    const c = createControls(844);
    c.keys.add("KeyW");
    pointerDown(c, "touch", 1, 100, 200);
    pointerDown(c, "touch", 2, 600, 200);
    releaseAll(c);
    expect([c.keys.size, c.move.active, c.aimStick.active]).toEqual([0, false, false]);
  });
});
