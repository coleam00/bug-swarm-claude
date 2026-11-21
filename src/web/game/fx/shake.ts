// Screen shake after a hit: a strength that falls to nothing over SHAKE_SECONDS, turned into
// a random offset each frame by fx's own seeded generator. Pure (no DOM, no canvas).
import { nextRandom, type Rng } from "../rng";

export const SHAKE_SECONDS = 0.25;
/** Arena units a hit shakes the screen by. */
export const HIT_SHAKE = 8;

export type Shake = {
  power: number;
  /** Seconds left. */
  left: number;
  /** Where to draw the arena this frame, in arena units. */
  offsetX: number;
  offsetY: number;
};

export function createShake(): Shake {
  return { power: 0, left: 0, offsetX: 0, offsetY: 0 };
}

/** The current strength, in arena units. */
export function shakeStrength(s: Shake): number {
  return (s.power * s.left) / SHAKE_SECONDS;
}

/** Starts a shake of `amount`, unless a stronger one is still running. */
export function kick(s: Shake, amount: number): void {
  if (amount < shakeStrength(s)) return;
  s.power = amount;
  s.left = SHAKE_SECONDS;
}

export function updateShake(s: Shake, dt: number, rng: Rng): void {
  s.left = Math.max(0, s.left - dt);
  if (s.left === 0) {
    s.offsetX = 0;
    s.offsetY = 0;
    return;
  }
  const m = shakeStrength(s);
  s.offsetX = (nextRandom(rng) * 2 - 1) * m;
  s.offsetY = (nextRandom(rng) * 2 - 1) * m;
}
