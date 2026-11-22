// Expanding rings (#78, the refactor bomb going off; release 1's ring): a fixed pool kept in typed
// arrays, so spawning and updating allocate nothing. Pure (no DOM, no canvas): the renderer reads
// each live ring's radius and opacity through ringAt.

export const RING_CAPACITY = 8;
/** How long a ring takes to reach its radius, seconds (release 1's BOMB_RING_SECONDS). */
export const RING_S = 0.5;

export type Rings = {
  x: Float32Array;
  y: Float32Array;
  /** The radius it grows to, world units. */
  radius: Float32Array;
  /** Seconds since it started; a slot is free when this is at least RING_S. */
  age: Float32Array;
  /** Slots in use. */
  live: number;
  /** The next slot to write, round-robin, so it is the oldest one. */
  cursor: number;
};

export function createRings(capacity = RING_CAPACITY): Rings {
  const age = new Float32Array(capacity).fill(RING_S);
  return { x: new Float32Array(capacity), y: new Float32Array(capacity), radius: new Float32Array(capacity), age, live: 0, cursor: 0 };
}

/** Starts a ring at (x, y) growing to `radius`. When the pool is full the oldest is overwritten. */
export function spawnRing(r: Rings, x: number, y: number, radius: number): void {
  const i = r.cursor;
  r.cursor = (i + 1) % r.age.length;
  if (r.age[i]! >= RING_S) r.live++;
  r.x[i] = x;
  r.y[i] = y;
  r.radius[i] = radius;
  r.age[i] = 0;
}

export function updateRings(r: Rings, dt: number): void {
  if (r.live === 0) return;
  for (let i = 0; i < r.age.length; i++) {
    if (r.age[i]! >= RING_S) continue;
    r.age[i] = r.age[i]! + dt;
    if (r.age[i]! >= RING_S) r.live--;
  }
}

/** Where a ring is: a share `k` of RING_S in, its radius is k of the full one and its opacity 1 - k². */
export type RingAt = { radius: number; alpha: number };

/**
 * A ring `age` seconds old growing to `radius`, written into `out` (no allocation): false once it
 * is over. Release 1's look: bright and full width most of the way, fading only near the end.
 */
export function ringAt(age: number, radius: number, out: RingAt): boolean {
  if (age < 0 || age >= RING_S) return false;
  const k = age / RING_S;
  out.radius = k * radius;
  out.alpha = 1 - k * k;
  return true;
}
