// Floating "+10" labels over squashed bugs: a fixed pool, overwritten oldest first when full.
// Pure (no DOM, no canvas).
import { POINTS_PER_SQUASH } from "../../../server/rules";

export const TEXT_CAPACITY = 32;
/** Arena units a second a label rises. */
export const TEXT_RISE = 40;
/** Seconds a label lives, fading as it goes. */
export const TEXT_SECONDS = 0.8;
/** Built once: the renderer never builds strings per frame. */
export const SQUASH_LABEL = `+${POINTS_PER_SQUASH}`;

export type Texts = {
  x: Float32Array;
  y: Float32Array;
  /** Seconds left; a slot is free when this is 0. */
  life: Float32Array;
  live: number;
  cursor: number;
};

export function createTexts(capacity = TEXT_CAPACITY): Texts {
  return { x: new Float32Array(capacity), y: new Float32Array(capacity), life: new Float32Array(capacity), live: 0, cursor: 0 };
}

export function spawnText(t: Texts, x: number, y: number): void {
  const i = t.cursor;
  t.cursor = (i + 1) % t.life.length;
  if (t.life[i]! <= 0) t.live++;
  t.x[i] = x;
  t.y[i] = y;
  t.life[i] = TEXT_SECONDS;
}

export function updateTexts(t: Texts, dt: number): void {
  if (t.live === 0) return;
  const cap = t.life.length;
  for (let i = 0; i < cap; i++) {
    if (t.life[i]! <= 0) continue;
    t.y[i]! -= TEXT_RISE * dt;
    t.life[i]! -= dt;
    if (t.life[i]! <= 0) {
      t.life[i] = 0;
      t.live--;
    }
  }
}
