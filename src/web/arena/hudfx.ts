// The HUD's moments (#55), as pure timers fed by your snapshot numbers (`me`): the multiplier
// pulsing when it goes up, a short "streak lost" flick when a streak of 5 or more resets, a flash
// when you take a hit, and the heat arc flashing just before the gun locks and while it is locked.
// No DOM, no clock: main.ts passes the numbers and the frame time.
import { HEAT_WARN } from "../../shared/arena/constants";
import type { SnapshotMe } from "../../shared/arena/protocol";

/** How long the multiplier pulses after it rises, seconds. */
export const PULSE_S = 0.3;
/** How long "streak lost" shows, seconds. */
export const STREAK_LOST_S = 0.6;
/** A streak this long or longer shows "streak lost" when it resets. */
export const STREAK_LOST_FROM = 5;
/** How long a hit flashes, seconds. */
export const HIT_FLASH_S = 0.4;
/** The heat arc's warning flash, on-off cycles a second. */
export const HEAT_FLASH_HZ = 6;

export type HudFx = {
  /** The last numbers seen, or null before the first. */
  last: { mu: number; st: number; hl: number; al: number } | null;
  /** Seconds left of each moment. */
  pulse: number;
  lost: number;
  hit: number;
};

export function createHudFx(): HudFx {
  return { last: null, pulse: 0, lost: 0, hit: 0 };
}

/** Forgets the last numbers (a new arena or a new life), so nothing fires from the jump. */
export function resetHudFx(fx: HudFx): void {
  fx.last = null;
  fx.pulse = 0;
  fx.lost = 0;
  fx.hit = 0;
}

/** Your numbers from a snapshot. True when they show you just took a hit (for the shake). */
export function noteMe(fx: HudFx, me: SnapshotMe): boolean {
  const last = fx.last;
  let hit = false;
  if (last && last.al === 1 && me.al === 1) {
    if (me.mu > last.mu) fx.pulse = PULSE_S;
    if (last.st >= STREAK_LOST_FROM && me.st === 0) fx.lost = STREAK_LOST_S;
  }
  if (last && last.al === 1 && me.hl < last.hl) {
    fx.hit = HIT_FLASH_S;
    hit = true;
  }
  if (last) {
    last.mu = me.mu;
    last.st = me.st;
    last.hl = me.hl;
    last.al = me.al;
  } else fx.last = { mu: me.mu, st: me.st, hl: me.hl, al: me.al };
  return hit;
}

export function updateHudFx(fx: HudFx, dt: number): void {
  fx.pulse = Math.max(0, fx.pulse - dt);
  fx.lost = Math.max(0, fx.lost - dt);
  fx.hit = Math.max(0, fx.hit - dt);
}

/** How much bigger the multiplier is drawn now: 1, swelling to 1.35 and back over a pulse. */
export function pulseScale(fx: HudFx): number {
  return 1 + 0.35 * Math.sin((Math.PI * fx.pulse) / PULSE_S);
}

/** Whether the heat arc is in its warning (near full, or locked). */
export function heatWarning(heat: number, locked: boolean): boolean {
  return locked || heat >= HEAT_WARN;
}

/** Whether a flashing thing is in its bright half at `t` seconds. */
export function flashOn(t: number, hz = HEAT_FLASH_HZ): boolean {
  return Math.floor(t * hz * 2) % 2 === 0;
}
