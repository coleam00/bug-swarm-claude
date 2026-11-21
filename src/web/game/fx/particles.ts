// The squash burst: a fixed pool of particles kept in typed arrays, so spawning and updating
// allocate nothing. Pure (no DOM, no canvas): the renderer reads the arrays and draws them.
import { nextRandom, type Rng } from "../rng";

export const PARTICLE_CAPACITY = 512;
export const BURST_COUNT = 14;
const SPEED_MIN = 60;
const SPEED_MAX = 220;
const LIFE_MIN = 0.35;
const LIFE_MAX = 0.6;
/** Fraction of its speed a particle keeps after one second. */
const DRAG = 0.04;

export type Particles = {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  /** Seconds left; a slot is free when this is 0. */
  life: Float32Array;
  maxLife: Float32Array;
  /** Index into the palette in look.ts. */
  colour: Uint8Array;
  /** Slots in use. */
  live: number;
  /** The next slot to write. Slots are handed out round-robin, so it is the oldest one. */
  cursor: number;
};

export function createParticles(capacity = PARTICLE_CAPACITY): Particles {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    colour: new Uint8Array(capacity),
    live: 0,
    cursor: 0,
  };
}

/**
 * Sprays `count` particles out of (x, y). When the pool is full the oldest particles are
 * overwritten, so the newest squash always shows. The pool never grows.
 */
export function spawnBurst(p: Particles, x: number, y: number, count: number, colour: number, rng: Rng): void {
  const cap = p.life.length;
  for (let n = 0; n < count; n++) {
    const i = p.cursor;
    p.cursor = (i + 1) % cap;
    if (p.life[i]! <= 0) p.live++;
    const angle = nextRandom(rng) * Math.PI * 2;
    const speed = SPEED_MIN + nextRandom(rng) * (SPEED_MAX - SPEED_MIN);
    const life = LIFE_MIN + nextRandom(rng) * (LIFE_MAX - LIFE_MIN);
    p.x[i] = x;
    p.y[i] = y;
    p.vx[i] = Math.cos(angle) * speed;
    p.vy[i] = Math.sin(angle) * speed;
    p.life[i] = life;
    p.maxLife[i] = life;
    p.colour[i] = colour;
  }
}

/** Moves every live particle by `dt` seconds of real time and frees the ones that expire. */
export function updateParticles(p: Particles, dt: number): void {
  if (p.live === 0) return;
  const keep = Math.pow(DRAG, dt);
  const cap = p.life.length;
  for (let i = 0; i < cap; i++) {
    if (p.life[i]! <= 0) continue;
    p.vx[i]! *= keep;
    p.vy[i]! *= keep;
    p.x[i]! += p.vx[i]! * dt;
    p.y[i]! += p.vy[i]! * dt;
    p.life[i]! -= dt;
    if (p.life[i]! <= 0) {
      p.life[i] = 0;
      p.live--;
    }
  }
}
