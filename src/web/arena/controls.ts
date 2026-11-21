// Arena input to a move vector, an aim angle and fire. Keyboard: WASD or arrows move (release 1's
// keysToInput), the mouse aims at its spot on screen and holding its left button fires. Touch:
// twin floating sticks, release 1's stick.ts twice: a finger landing on the left half of the
// screen holds the move stick, one on the right half the aim stick; a second finger on a side
// already held is ignored. The aim stick, dragged past STICK_DEAD, sets the aim and fires while
// held (direction = aim, held = fire); the last aim is kept otherwise. Nothing fires for you.
// A respawn is one press (`pressRespawn`), sent as the next input's dash. Pure: main.ts feeds it
// DOM events in CSS px relative to the canvas.
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
  /** The mouse's left button (or a pen's tip) is held. */
  firing: boolean;
  /** A respawn press waiting for the next input. */
  respawn: boolean;
};

export function createControls(width: number): Controls {
  return {
    keys: new Set(),
    move: createStick(),
    aimStick: createStick(),
    mouse: { on: false, x: 0, y: 0 },
    width,
    aim: 0,
    touched: false,
    firing: false,
    respawn: false,
  };
}

export type PointerKind = "touch" | "mouse" | "pen";

/** A press. `button` is the DOM's: 0 is the left mouse button or a pen's tip. */
export function pointerDown(c: Controls, kind: PointerKind, id: number, x: number, y: number, button = 0): void {
  if (kind !== "touch") {
    c.mouse.on = true;
    c.mouse.x = x;
    c.mouse.y = y;
    if (button === 0) c.firing = true;
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

export function pointerUp(c: Controls, kind: PointerKind, id: number, button = 0): void {
  if (kind !== "touch") {
    if (button === 0) c.firing = false;
    return;
  }
  if (!stickUp(c.move, id)) stickUp(c.aimStick, id);
}

/** Lets go of everything (the window lost focus). */
export function releaseAll(c: Controls): void {
  c.keys.clear();
  c.firing = false;
  stickUp(c.move, c.move.id);
  stickUp(c.aimStick, c.aimStick.id);
}

/** Asks for a respawn: the next input carries it as a dash press, once. */
export function pressRespawn(c: Controls): void {
  c.respawn = true;
}

const drive: StickOut = { kind: "stick", dx: 0, dy: 0 };

/**
 * This step's move, aim and fire into `out`. Held keys win over the move stick. The aim stick,
 * else the mouse (aimed from `selfX, selfY`, your robot on screen in CSS px), sets the aim; else
 * it stays. Fire is the held left button, or the aim stick held past its dead zone. `dash` is a
 * waiting respawn press, consumed here. The move may be longer than 1 (a diagonal key pair); the
 * sim clamps it.
 */
export function readControls(
  c: Controls,
  selfX: number,
  selfY: number,
  out: { mx: number; my: number; aim: number; fire: boolean; dash: boolean },
): void {
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
  const aiming = s.active && Math.hypot(s.x - s.cx, s.y - s.cy) >= STICK_DEAD;
  if (aiming) c.aim = Math.atan2(s.y - s.cy, s.x - s.cx);
  else if (c.mouse.on && (c.mouse.x !== selfX || c.mouse.y !== selfY)) c.aim = Math.atan2(c.mouse.y - selfY, c.mouse.x - selfX);
  out.aim = c.aim;
  out.fire = aiming || c.firing;
  out.dash = c.respawn;
  c.respawn = false;
}
