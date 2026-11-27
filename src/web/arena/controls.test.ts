import { describe, expect, test } from "bun:test";
import { STICK_DEAD, STICK_RANGE } from "../game/stick";
import { NO_INSETS, type Insets } from "../game/hud";
import { STEERING_KEYS } from "../game/keys";
import {
  DASH_BUTTON_RADIUS,
  DASH_BUTTON_SLOP,
  DASH_KEYS,
  aimZoneTop,
  createControls,
  dashButtonAt,
  pointerDown,
  pointerMove,
  pointerUp,
  pressDash,
  pressRespawn,
  readControls,
  releaseAll,
} from "./controls";
import { minimapLayout } from "./minimap";

const out = () => ({ mx: 0, my: 0, aim: 0, fire: false, dash: false, respawn: false });

describe("fire and respawn", () => {
  test("holding the left mouse button fires; other buttons and letting go do not", () => {
    const c = createControls(1440);
    const o = out();
    pointerDown(c, "mouse", 1, 800, 450, 2);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(false);
    pointerDown(c, "mouse", 1, 800, 450, 0);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(true);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(true);
    pointerUp(c, "mouse", 1, 0);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(false);
    pointerDown(c, "mouse", 1, 800, 450, 0);
    releaseAll(c);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(false);
  });

  test("the click that respawns does not fire until it is let go; the next press does", () => {
    const c = createControls(1440);
    const o = out();
    // main.ts: a press while out calls pressRespawn, then pointerDown.
    pressRespawn(c);
    pointerDown(c, "mouse", 1, 800, 450, 0);
    readControls(c, 700, 450, o);
    expect([o.respawn, o.fire]).toEqual([true, false]);
    readControls(c, 700, 450, o);
    expect([o.respawn, o.fire]).toEqual([false, false]);
    pointerUp(c, "mouse", 1, 0);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(false);
    pointerDown(c, "mouse", 1, 800, 450, 0);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(true);
  });

  test("the tap that respawns on the aim side does not fire until the thumb lifts", () => {
    const c = createControls(844);
    const o = out();
    pressRespawn(c);
    pointerDown(c, "touch", 2, 650, 200);
    pointerMove(c, "touch", 2, 650 + STICK_DEAD + 1, 200);
    readControls(c, 0, 0, o);
    expect([o.respawn, o.fire]).toEqual([true, false]);
    pointerUp(c, "touch", 2);
    readControls(c, 0, 0, o);
    pointerDown(c, "touch", 3, 650, 200);
    pointerMove(c, "touch", 3, 650 + STICK_DEAD + 1, 200);
    readControls(c, 0, 0, o);
    expect(o.fire).toBe(true);
  });

  test("a key that respawns leaves a later click free to fire at once", () => {
    const c = createControls(1440);
    const o = out();
    pressRespawn(c);
    readControls(c, 700, 450, o);
    expect(o.respawn).toBe(true);
    pointerDown(c, "mouse", 1, 800, 450, 0);
    readControls(c, 700, 450, o);
    expect(o.fire).toBe(true);
  });

  test("the aim stick fires while held past its dead zone, and stops when the thumb lifts", () => {
    const c = createControls(844);
    const o = out();
    pointerDown(c, "touch", 2, 650, 200);
    readControls(c, 0, 0, o);
    expect(o.fire).toBe(false);
    pointerMove(c, "touch", 2, 650 + STICK_DEAD + 1, 200);
    readControls(c, 0, 0, o);
    expect(o.fire).toBe(true);
    expect(o.aim).toBe(0);
    pointerUp(c, "touch", 2);
    readControls(c, 0, 0, o);
    expect(o.fire).toBe(false);
    // The move stick never fires.
    pointerDown(c, "touch", 1, 100, 200);
    pointerMove(c, "touch", 1, 160, 200);
    readControls(c, 0, 0, o);
    expect(o.fire).toBe(false);
  });

  test("a respawn press is read once, apart from a dash press", () => {
    const c = createControls(1440);
    const o = out();
    pressRespawn(c);
    readControls(c, 0, 0, o);
    expect([o.respawn, o.dash]).toEqual([true, false]);
    readControls(c, 0, 0, o);
    expect(o.respawn).toBe(false);
  });
});

describe("dash", () => {
  /** Controls on a `w` x `h` screen with the dash button laid out. */
  const screen = (w: number, h: number) => {
    const c = createControls(w);
    dashButtonAt(w, h, NO_INSETS, c.dashButton);
    return c;
  };

  test("Space and both Shifts are the dash keys, and no move key is", () => {
    for (const k of ["Space", "ShiftLeft", "ShiftRight"]) expect(DASH_KEYS.has(k)).toBe(true);
    for (const k of STEERING_KEYS) expect(DASH_KEYS.has(k)).toBe(false);
  });

  test("a dash press (pressDash) dashes once", () => {
    const c = screen(1280, 720);
    const o = out();
    pressDash(c);
    readControls(c, 0, 0, o);
    expect([o.dash, o.respawn]).toEqual([true, false]);
    readControls(c, 0, 0, o);
    expect(o.dash).toBe(false);
  });

  test("the right mouse button dashes and the left fires", () => {
    const c = screen(1280, 720);
    const o = out();
    pointerDown(c, "mouse", 1, 300, 300, 2);
    readControls(c, 640, 360, o);
    expect([o.dash, o.fire]).toEqual([true, false]);
    pointerUp(c, "mouse", 1, 0);
    pointerDown(c, "mouse", 1, 300, 300, 0);
    readControls(c, 640, 360, o);
    expect([o.dash, o.fire]).toEqual([false, true]);
  });

  test("right while holding left (a move with buttons 3) dashes and keeps firing; either release order lets go", () => {
    for (const leftFirst of [true, false]) {
      const c = screen(1280, 720);
      const o = out();
      pointerDown(c, "mouse", 1, 300, 300, 0, 1);
      pointerMove(c, "mouse", 1, 300, 300, 3);
      readControls(c, 640, 360, o);
      expect([o.dash, o.fire]).toEqual([true, true]);
      pointerMove(c, "mouse", 1, 310, 300, 3);
      readControls(c, 640, 360, o);
      expect([o.dash, o.fire]).toEqual([false, true]);
      if (leftFirst) {
        pointerMove(c, "mouse", 1, 310, 300, 2);
        readControls(c, 640, 360, o);
        expect([o.dash, o.fire]).toEqual([false, false]);
        pointerUp(c, "mouse", 1, 0);
      } else {
        pointerMove(c, "mouse", 1, 310, 300, 1);
        readControls(c, 640, 360, o);
        expect([o.dash, o.fire]).toEqual([false, true]);
        pointerUp(c, "mouse", 1, 0);
      }
      readControls(c, 640, 360, o);
      expect([o.dash, o.fire]).toEqual([false, false]);
    }
  });

  test("on a desktop there is no dash button: a click where it would be fires and does not dash", () => {
    const c = screen(1280, 720);
    const o = out();
    expect(c.dashButtonOn).toBe(false);
    pointerDown(c, "mouse", 1, c.dashButton.x, c.dashButton.y, 0);
    readControls(c, 640, 360, o);
    expect([o.dash, o.fire]).toEqual([false, true]);
  });

  test("the first finger turns the dash button on, and that touch on it dashes", () => {
    const c = screen(844, 390);
    const o = out();
    pointerDown(c, "touch", 3, c.dashButton.x, c.dashButton.y);
    readControls(c, 422, 195, o);
    expect([c.dashButtonOn, o.dash, c.aimStick.active]).toEqual([true, true, false]);
  });

  test("clicking the dash button (on a touch screen) dashes and does not fire, even held and dragged off", () => {
    const c = screen(1280, 720);
    c.dashButtonOn = true;
    const o = out();
    pointerDown(c, "mouse", 1, c.dashButton.x + 10, c.dashButton.y - 10, 0);
    readControls(c, 640, 360, o);
    expect([o.dash, o.fire]).toEqual([true, false]);
    pointerMove(c, "mouse", 1, 400, 300, 1);
    readControls(c, 640, 360, o);
    expect([o.dash, o.fire]).toEqual([false, false]);
    pointerUp(c, "mouse", 1, 0);
    pointerDown(c, "mouse", 1, 400, 300, 0);
    readControls(c, 640, 360, o);
    expect(o.fire).toBe(true);
  });

  test("two fingers: one on the move stick, one tapping the dash button: a move and a dash, and no aim stick", () => {
    for (const [w, h] of [
      [390, 844],
      [844, 390],
    ] as const) {
      const c = screen(w, h);
      const o = out();
      pointerDown(c, "touch", 1, 80, h - 100);
      pointerMove(c, "touch", 1, 140, h - 100);
      pointerDown(c, "touch", 2, c.dashButton.x, c.dashButton.y);
      readControls(c, 0, 0, o);
      expect(o.mx).toBeGreaterThan(0.5);
      expect([o.dash, o.fire, c.aimStick.active]).toEqual([true, false, false]);
      // The finger on the button sliding does not drag an aim stick, and lifting it frees the button.
      pointerMove(c, "touch", 2, c.dashButton.x - 60, c.dashButton.y + 40);
      readControls(c, 0, 0, o);
      expect([o.dash, c.aimStick.active, c.dashButton.id]).toEqual([false, false, 2]);
      pointerUp(c, "touch", 2);
      expect(c.dashButton.id).toBe(-1);
      // The move finger kept moving throughout.
      expect(o.mx).toBeGreaterThan(0.5);
      // A finger on the right half away from the button still aims.
      pointerDown(c, "touch", 3, w - 40, h - 40);
      expect(c.aimStick.active).toBe(true);
    }
  });

  /** A landscape and a portrait phone's safe-area insets (notch and home bar). */
  const LANDSCAPE_INSETS = { top: 0, right: 47, bottom: 21, left: 47 };
  const PORTRAIT_INSETS = { top: 47, right: 0, bottom: 34, left: 0 };

  test("the button sits on screen, in the right half, clear of the minimap, and big enough to tap", () => {
    for (const [w, h, ins] of [
      [390, 844, NO_INSETS],
      [390, 844, PORTRAIT_INSETS],
      [844, 390, NO_INSETS],
      [844, 390, LANDSCAPE_INSETS],
      [1280, 720, NO_INSETS],
      [667, 320, NO_INSETS],
      [562, 260, NO_INSETS],
    ] as const) {
      const b = dashButtonAt(w, h, ins, { x: 0, y: 0, r: 0, id: -1 });
      expect(b.r * 2).toBeGreaterThanOrEqual(44);
      expect(b.r).toBe(DASH_BUTTON_RADIUS);
      // Its whole tap reach is above the aim zone (#124).
      expect([w, h, b.y + b.r + DASH_BUTTON_SLOP < aimZoneTop(h, ins)]).toEqual([w, h, true]);
      expect(b.x - b.r).toBeGreaterThan(w / 2);
      expect(b.x + b.r).toBeLessThanOrEqual(w - ins.right);
      expect(b.y - b.r).toBeGreaterThanOrEqual(ins.top);
      // Under the minimap, or left of it.
      const m = minimapLayout(w, h, ins);
      expect([w, h, b.y - b.r > m.y + m.size || b.x + b.r < m.x]).toEqual([w, h, true]);
    }
  });

  // #124: on a phone the right thumb resting on the aim stick dashed instead of aiming.
  /**
   * Where the right thumb rests: the issue's working spot, playtest's aim thumb, and the issue's
   * failing spot (186 px up). In landscape also spots up and right of those, which dashed on the
   * old layout.
   */
  const restingSpots = (w: number, h: number): [number, number][] => [
    [w - 98, h - 101],
    [Math.round(0.72 * w), h - 110],
    [w - 98, h - 186],
    ...(h < w
      ? ([
          [w - 89, h - 186],
          [w - 74, h - 165],
          [w - 64, h - 150],
          [w - 54, h - 160],
        ] as [number, number][])
      : []),
  ];
  const PHONES = [
    [390, 844, NO_INSETS],
    [390, 844, PORTRAIT_INSETS],
    [844, 390, NO_INSETS],
    [844, 390, LANDSCAPE_INSETS],
  ] as const;
  /** Controls on a `w` x `h` touch screen with the dash button laid out for `ins`. */
  const phone = (w: number, h: number, ins: Insets) => {
    const c = createControls(w);
    dashButtonAt(w, h, ins, c.dashButton);
    c.dashButtonOn = true;
    return c;
  };

  test("a phone thumb starting at the right stick's resting spot aims and fires and never dashes (#124)", () => {
    for (const [w, h, ins] of PHONES) {
      for (const [x, y] of restingSpots(w, h)) {
        const c = phone(w, h, ins);
        const o = out();
        // The spot is in the aim zone, which the button keeps clear of.
        expect([w, h, x, y, y >= aimZoneTop(h, ins)]).toEqual([w, h, x, y, true]);
        pointerDown(c, "touch", 2, x, y);
        pointerMove(c, "touch", 2, x - STICK_DEAD * 3, y);
        readControls(c, 0, 0, o);
        expect([w, h, x, y, o.dash, o.fire, c.aimStick.active]).toEqual([w, h, x, y, false, true, true]);
      }
    }
  });

  test("an aim thumb sliding over the dash button keeps aiming and firing and never dashes (#124)", () => {
    for (const [w, h, ins] of PHONES) {
      for (const [x, y] of restingSpots(w, h)) {
        const c = phone(w, h, ins);
        const o = out();
        pointerDown(c, "touch", 2, x, y);
        for (const [px, py] of [
          [c.dashButton.x, c.dashButton.y],
          [x - STICK_DEAD * 3, y],
        ] as [number, number][]) {
          pointerMove(c, "touch", 2, px, py);
          readControls(c, 0, 0, o);
          expect([w, h, x, y, o.dash, o.fire, c.aimStick.active, c.dashButton.id]).toEqual([w, h, x, y, false, true, true, -1]);
        }
      }
    }
  });

  test("on a phone a tap on the dash button, at its centre or the edge of its reach, still dashes and starts no stick (#124)", () => {
    for (const [w, h, ins] of PHONES) {
      const b = phone(w, h, ins).dashButton;
      for (const [x, y] of [
        [b.x, b.y],
        [b.x, b.y + b.r + DASH_BUTTON_SLOP - 1],
      ] as [number, number][]) {
        const c = phone(w, h, ins);
        c.dashButtonOn = false;
        const o = out();
        pointerDown(c, "touch", 3, x, y);
        readControls(c, 0, 0, o);
        expect([w, h, o.dash, c.aimStick.active, c.dashButton.id]).toEqual([w, h, true, false, 3]);
      }
    }
  });
});

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
