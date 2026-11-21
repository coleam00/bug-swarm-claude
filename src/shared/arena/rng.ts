// A seeded random generator (mulberry32), the same algorithm as release 1's src/web/game/rng.ts.
// Copied rather than imported, so src/shared stands alone. Its state is a plain number kept in
// the arena state, so an arena replays exactly from its seed.
export type Rng = { state: number };

export function createRng(seed: number): Rng {
  return { state: seed | 0 };
}

/** The next number in [0, 1). */
export function nextRandom(rng: Rng): number {
  let t = (rng.state = (rng.state + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
