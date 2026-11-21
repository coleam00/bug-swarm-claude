// Arena input to a move vector and an aim angle. Keyboard: WASD or arrows move (release 1's
// keysToInput), the mouse aims at its spot on screen. Touch: twin floating sticks, release 1's
// stick.ts twice: a finger landing on the left half of the screen holds the move stick, one on
// the right half the aim stick; a second finger on a side already held is ignored. The aim stick
// sets the aim once dragged past STICK_DEAD; the last aim is kept otherwise. Pure: main.ts feeds
// it DOM events in CSS px relative to the canvas.
import { keysToInput } from "../game/keys";
import { STICK_DEAD, createStick, stickDown, stickDrive, stickMove, stickUp, type Stick, type StickOut } from "../game/stick";

export type Controls = {
  /** Held keys, by KeyboardEvent.code. */
  keys: Set<string>;
  move: Stick;
  aimStick: Stick;
  /** The mouse over the canvas, CSS px, once it has moved there. */
  mouse: { on: boolean; x: number; y: number };
  /** The canvas width, CSS px: its left half moves, its right half aims. */
  width: number;
  /** The aim angle, radians, kept when nothing sets a new one. */
  aim: number;
  /** A finger has touched: the hello's touch flag. */
  touched: boolean;
};

export function createControls(width: number): Controls {
  return { keys: new Set(), move: createStick(), aimStick: createStick(), mouse: { on: false, x: 0, y: 0 }, width, aim: 0, touched: false };
}

export type PointerKind = "touch" | "mouse" | "pen";

export function pointerDown(c: Controls, kind: PointerKind, id: number, x: number, y: number): void {
  if (kind !== "touch") {
    c.mouse.on = true;
    c.mouse.x = x;
    c.mouse.y = y;
    return;
  }
  c.touched = true;
  c.mouse.on = false;
  stickDown(x < c.width / 2 ? c.move : c.aimStick, id, x, y);
}

export function pointerMove(c: Controls, kind: PointerKind, id: number, x: number, y: number): void {
  if (kind !== "touch") {
    c.mouse.on = true;
    c.mouse.x = x;
    c.mouse.y = y;
    return;
  }
  if (!stickMove(c.move, id, x, y)) stickMove(c.aimStick, id, x, y);
}

export function pointerUp(c: Controls, kind: PointerKind, id: number): void {
  if (kind !== "touch") return;
  if (!stickUp(c.move, id)) stickUp(c.aimStick, id);
}

/** Lets go of everything (the window lost focus). */
export function releaseAll(c: Controls): void {
  c.keys.clear();
  stickUp(c.move, c.move.id);
  stickUp(c.aimStick, c.aimStick.id);
}

const drive: StickOut = { kind: "stick", dx: 0, dy: 0 };

/**
 * This step's move and aim into `out`. Held keys win over the move stick. The aim stick, else the
 * mouse (aimed from `selfX, selfY`, your robot on screen in CSS px), sets the aim; else it stays.
 * The move may be longer than 1 (a diagonal key pair); the sim clamps it.
 */
export function readControls(c: Controls, selfX: number, selfY: number, out: { mx: number; my: number; aim: number }): void {
  const keys = keysToInput(c.keys);
  if (keys.kind === "direction") {
    out.mx = keys.dx;
    out.my = keys.dy;
  } else if (stickDrive(c.move, drive)) {
    out.mx = drive.dx;
    out.my = drive.dy;
  } else {
    out.mx = 0;
    out.my = 0;
  }
  const s = c.aimStick;
  if (s.active && Math.hypot(s.x - s.cx, s.y - s.cy) >= STICK_DEAD) c.aim = Math.atan2(s.y - s.cy, s.x - s.cx);
  else if (c.mouse.on && (c.mouse.x !== selfX || c.mouse.y !== selfY)) c.aim = Math.atan2(c.mouse.y - selfY, c.mouse.x - selfX);
  out.aim = c.aim;
}
