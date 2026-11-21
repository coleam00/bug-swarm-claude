// The test shield's bubble popping when it blocks a hit: a ring that grows and fades where the
// robot was. A small fixed pool, overwritten oldest first when full. Pure (no DOM, no canvas).

export const POP_CAPACITY = 4;
/** Seconds a pop lasts. */
export const POP_SECONDS = 0.3;

export type Pops = {
  x: Float32Array;
  y: Float32Array;
  /** Seconds left; a slot is free when this is 0. */
  life: Float32Array;
  live: number;
  cursor: number;
};

export function createPops(capacity = POP_CAPACITY): Pops {
  return { x: new Float32Array(capacity), y: new Float32Array(capacity), life: new Float32Array(capacity), live: 0, cursor: 0 };
}

export function spawnPop(p: Pops, x: number, y: number): void {
  const i = p.cursor;
  p.cursor = (i + 1) % p.life.length;
  if (p.life[i]! <= 0) p.live++;
  p.x[i] = x;
  p.y[i] = y;
  p.life[i] = POP_SECONDS;
}

export function updatePops(p: Pops, dt: number): void {
  if (p.live === 0) return;
  for (let i = 0; i < p.life.length; i++) {
    if (p.life[i]! <= 0) continue;
    p.life[i]! -= dt;
    if (p.life[i]! <= 0) {
      p.life[i] = 0;
      p.live--;
    }
  }
}
