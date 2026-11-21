// Arena input to a move vector, an aim angle and fire. Keyboard: WASD or arrows move (release 1's
// keysToInput), the mouse aims at its spot on screen and holding its left button fires. Touch:
// twin floating sticks, release 1's stick.ts twice: a finger landing on the left half of the
// screen holds the move stick, one on the right half the aim stick; a second finger on a side
// already held is ignored. The aim stick, dragged past STICK_DEAD, sets the aim and fires while
// held (direction = aim, held = fire); the last aim is kept otherwise. Nothing fires for you.
// Dash (#60): Space or Shift (`pressDash`), the right mouse button, or the round dash button above
// the right stick (`dashButtonAt`). The button is there only on a touch screen (#64): a coarse
// pointer, or once a finger has touched (`dashButtonOn`); then any pointer can tap it, and a finger
// on it never starts a stick. A respawn is one press (`pressRespawn`); both go out as the next input's dash, the dash
// while alive and the respawn while out. Pure: main.ts feeds it DOM events in CSS px relative to
// the canvas.
import type { Insets } from "../game/hud";
import { keysToInput } from "../game/keys";
import { STICK_DEAD, createStick, stickDown, stickDrive, stickMove, stickUp, type Stick, type StickOut } from "../game/stick";
import { minimapLayout } from "./minimap";

/** Keys that dash (KeyboardEvent.code). */
export const DASH_KEYS: ReadonlySet<string> = new Set(["Space", "ShiftLeft", "ShiftRight"]);
/** The dash button's radius, CSS px (68 px across: over the 44 px touch target). */
export const DASH_BUTTON_RADIUS = 34;
/** A press this far outside the button's edge still counts, CSS px. */
export const DASH_BUTTON_SLOP = 6;
/** The button's centre, from the right and bottom safe edges, CSS px: above the right thumb's stick. */
export const DASH_BUTTON_RIGHT = 80;
export const DASH_BUTTON_BOTTOM = 200;

/** The dash button: centre and radius in CSS px, and the touch pointer holding it (-1: none). */
export type DashButton = { x: number; y: number; r: number; id: number };

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
  /** The mouse's left button (or a pen's tip) is held, and its press did not land on the dash button. */
  firing: boolean;
  /** The mouse buttons last seen held (the DOM's `buttons`: 1 left or a pen's tip, 2 right). */
  mouseButtons: number;
  /** The held left button went down on the dash button, so it does not fire. */
  leftOnDash: boolean;
  /** A respawn press waiting for the next input. */
  respawn: boolean;
  /** A dash press waiting for the next input. */
  dashPress: boolean;
  dashButton: DashButton;
  /** The dash button is shown and takes presses: a touch screen (game.ts sets it from `(pointer: coarse)`), or a finger has touched. */
  dashButtonOn: boolean;
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
    mouseButtons: 0,
    leftOnDash: false,
    respawn: false,
    dashPress: false,
    dashButton: { x: -1000, y: -1000, r: DASH_BUTTON_RADIUS, id: -1 },
    dashButtonOn: false,
  };
}

/**
 * Lays the dash button out on a `width` x `height` CSS px canvas, into `out`: DASH_BUTTON_RIGHT in
 * from the right safe edge and DASH_BUTTON_BOTTOM up from the bottom one, above where the right
 * thumb holds the aim stick, but never under the minimap (top right) nor off the bottom.
 */
export function dashButtonAt(width: number, height: number, insets: Insets, out: DashButton): DashButton {
  const r = DASH_BUTTON_RADIUS;
  const map = minimapLayout(width, height, insets);
  out.r = r;
  out.x = width - insets.right - DASH_BUTTON_RIGHT;
  const lowest = height - insets.bottom - r - 8;
  const highest = map.y + map.size + r + 12;
  out.y = Math.max(highest, Math.min(lowest, height - insets.bottom - DASH_BUTTON_BOTTOM));
  return out;
}

function onDashButton(c: Controls, x: number, y: number): boolean {
  if (!c.dashButtonOn) return false;
  const b = c.dashButton;
  const reach = b.r + DASH_BUTTON_SLOP;
  return (x - b.x) ** 2 + (y - b.y) ** 2 <= reach * reach;
}

export type PointerKind = "touch" | "mouse" | "pen";

/** The DOM's `buttons` bit for a `button`: 0 (left, a pen's tip) is 1, 2 (right) is 2. */
const BUTTON_BITS: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

/**
 * The mouse's buttons (the DOM's `buttons`, on every mouse event: a second button pressed while
 * one is held comes as a move, not a press). The left button fires while held, unless it went
 * down on the dash button; the right button dashes as it goes down.
 */
function setMouseButtons(c: Controls, buttons: number): void {
  if (buttons & 2 && !(c.mouseButtons & 2)) c.dashPress = true;
  if (!(buttons & 1)) c.leftOnDash = false;
  c.mouseButtons = buttons;
  c.firing = (buttons & 1) !== 0 && !c.leftOnDash;
}

/**
 * A press. `button` is the DOM's: 0 is the left mouse button or a pen's tip, 2 the right button
 * (a dash); `buttons` all those held now, `button`'s alone by default. A press on the dash button
 * dashes and does nothing else.
 */
export function pointerDown(c: Controls, kind: PointerKind, id: number, x: number, y: number, button = 0, buttons = BUTTON_BITS[button] ?? 0): void {
  if (kind === "touch") {
    c.touched = true;
    c.dashButtonOn = true;
    c.mouse.on = false;
  }
  if (onDashButton(c, x, y)) {
    c.dashPress = true;
    if (kind === "touch") c.dashButton.id = id;
    else {
      if (button === 0) c.leftOnDash = true;
      c.mouseButtons = buttons;
      c.firing = false;
    }
    return;
  }
  if (kind !== "touch") {
    c.mouse.on = true;
    c.mouse.x = x;
    c.mouse.y = y;
    setMouseButtons(c, buttons);
    return;
  }
  stickDown(x < c.width / 2 ? c.move : c.aimStick, id, x, y);
}

/** A move. `buttons` (mouse and pen): the DOM's buttons held now, when the event has them. */
export function pointerMove(c: Controls, kind: PointerKind, id: number, x: number, y: number, buttons?: number): void {
  if (kind !== "touch") {
    c.mouse.on = true;
    c.mouse.x = x;
    c.mouse.y = y;
    if (buttons !== undefined) setMouseButtons(c, buttons);
    return;
  }
  if (id === c.dashButton.id) return;
  if (!stickMove(c.move, id, x, y)) stickMove(c.aimStick, id, x, y);
}

/** A release. `buttons` (mouse and pen): the DOM's buttons still held, none by default. */
export function pointerUp(c: Controls, kind: PointerKind, id: number, buttons = 0): void {
  if (kind !== "touch") {
    setMouseButtons(c, buttons);
    return;
  }
  if (id === c.dashButton.id) {
    c.dashButton.id = -1;
    return;
  }
  if (!stickUp(c.move, id)) stickUp(c.aimStick, id);
}

/** Lets go of everything (the window lost focus). */
export function releaseAll(c: Controls): void {
  c.keys.clear();
  c.firing = false;
  c.mouseButtons = 0;
  c.leftOnDash = false;
  c.dashButton.id = -1;
  stickUp(c.move, c.move.id);
  stickUp(c.aimStick, c.aimStick.id);
}

/** Asks for a respawn: the next input carries it as a dash press, once. */
export function pressRespawn(c: Controls): void {
  c.respawn = true;
}

/** A dash press (a key): the next input carries it, once. */
export function pressDash(c: Controls): void {
  c.dashPress = true;
}

const drive: StickOut = { kind: "stick", dx: 0, dy: 0 };

/**
 * This step's move, aim and fire into `out`. Held keys win over the move stick. The aim stick,
 * else the mouse (aimed from `selfX, selfY`, your robot on screen in CSS px), sets the aim; else
 * it stays. Fire is the held left button, or the aim stick held past its dead zone. `dash` and
 * `respawn` are the presses waiting since the last read, consumed here: main.ts sends the one
 * that fits (the dash while alive, the respawn while out). The move may be longer than 1 (a diagonal key pair); the
 * sim clamps it.
 */
export function readControls(
  c: Controls,
  selfX: number,
  selfY: number,
  out: { mx: number; my: number; aim: number; fire: boolean; dash: boolean; respawn: boolean },
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
  out.dash = c.dashPress;
  out.respawn = c.respawn;
  c.dashPress = false;
  c.respawn = false;
}
