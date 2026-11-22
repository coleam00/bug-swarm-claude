// The "ting" a shot makes when a beetle's shell blocks it (#80): a ring that grows and fades at
// the spot, and a small pale-blue "ting" rising over it, so a blocked shot reads at a glance apart
// from a hit's yellow spark. A fixed pool in typed arrays: spawning and updating allocate nothing.
// A block close to a ting still young restarts that one instead of adding another, so a stream of
// shots on one shell shows one ringing ting, not a pile. Pure (no DOM, no canvas).

/** The most tings alive at once: at most 3 beetles, each rung by a few players. */
export const TING_CAPACITY = 16;
/** How long a ting shows, seconds: the ring over TING_RING_S, the word a little longer. */
export const TING_S = 0.45;
export const TING_RING_S = 0.2;
/** The ring grows from this radius to that, world units. */
export const TING_RING_FROM = 6;
export const TING_RING_TO = 26;
/** How far the word rises over its life, world units. */
export const TING_RISE = 18;
/** A block within this of a ting younger than TING_MERGE_S restarts it, world units. */
export const TING_MERGE = 24;
export const TING_MERGE_S = 0.3;

export type Tings = {
  x: Float32Array;
  y: Float32Array;
  /** Seconds since it rang; a slot is free once this reaches TING_S. */
  age: Float64Array;
  live: number;
  cursor: number;
};

export function createTings(capacity = TING_CAPACITY): Tings {
  return { x: new Float32Array(capacity), y: new Float32Array(capacity), age: new Float64Array(capacity).fill(TING_S), live: 0, cursor: 0 };
}

/** A shell blocked a shot at (x, y). */
export function spawnTing(t: Tings, x: number, y: number): void {
  const cap = t.age.length;
  for (let i = 0; i < cap; i++) {
    if (t.age[i]! >= TING_MERGE_S) continue;
    const dx = t.x[i]! - x;
    const dy = t.y[i]! - y;
    if (dx * dx + dy * dy <= TING_MERGE * TING_MERGE) {
      t.age[i] = 0;
      return;
    }
  }
  const i = t.cursor;
  t.cursor = (i + 1) % cap;
  if (t.age[i]! >= TING_S) t.live++;
  t.x[i] = x;
  t.y[i] = y;
  t.age[i] = 0;
}

export function updateTings(t: Tings, dt: number): void {
  if (t.live === 0) return;
  for (let i = 0; i < t.age.length; i++) {
    const a = t.age[i]!;
    if (a >= TING_S) continue;
    t.age[i] = Math.min(TING_S, a + dt);
    if (t.age[i]! >= TING_S) t.live--;
  }
}

/** How a ting looks `seconds` after it rang: its ring's radius and alpha (0 once the ring is done), the word's alpha and rise. */
export type TingLook = { ring: number; ringAlpha: number; wordAlpha: number; rise: number };

/** Writes how a ting looks `seconds` after it rang into `out`. Pure; allocates nothing. */
export function tingLook(seconds: number, out: TingLook): TingLook {
  const r = Math.min(1, Math.max(0, seconds / TING_RING_S));
  const p = Math.min(1, Math.max(0, seconds / TING_S));
  out.ring = TING_RING_FROM + (TING_RING_TO - TING_RING_FROM) * (1 - (1 - r) * (1 - r));
  out.ringAlpha = seconds < TING_RING_S ? 1 - r : 0;
  out.wordAlpha = seconds < TING_S ? Math.min(1, 4 * (1 - p)) : 0;
  out.rise = TING_RISE * p;
  return out;
}
