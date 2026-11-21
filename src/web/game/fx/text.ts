// Floating "+10" labels over squashed bugs. Squashes close together in place and time merge into
// one label ("+30") so a full swarm never piles labels into unreadable clutter. A fixed pool: when
// it is full the label with the least life left is overwritten. Pure (no DOM, no canvas).
import { POINTS_PER_SQUASH } from "../../../server/rules";

/** The most labels alive at once. */
export const TEXT_CAPACITY = 12;
/** Arena units a second a label rises. */
export const TEXT_RISE = 40;
/** Seconds a label lives, fading as it goes; a merge starts it again. */
export const TEXT_SECONDS = 0.8;
/** A squash joins a label merged into (or made) at most this many seconds ago... */
export const TEXT_MERGE_SECONDS = 0.25;
/** ...and at most this many CSS px away: about one "+10" wide, so two labels never overlap. */
export const TEXT_MERGE_PX = 48;
/** A label stops taking squashes at this many, so its text is always in TEXT_LABELS. */
export const TEXT_MAX_SQUASHES = 99;
/** Every label's text by its squash count, built once: the renderer never builds strings per frame. */
export const TEXT_LABELS: readonly string[] = Array.from({ length: TEXT_MAX_SQUASHES + 1 }, (_, n) => `+${n * POINTS_PER_SQUASH}`);

export type Texts = {
  x: Float32Array;
  y: Float32Array;
  /** Seconds left; a slot is free when this is 0. */
  life: Float32Array;
  /** Squashes in the label: its text is TEXT_LABELS[count]. */
  count: Uint8Array;
  /** Seconds since the label last took a squash. */
  since: Float32Array;
  /** TEXT_MERGE_PX in arena units at the current layout (setTextScale). */
  mergeRadius: number;
  live: number;
};

export function createTexts(capacity = TEXT_CAPACITY): Texts {
  return {
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    life: new Float32Array(capacity),
    count: new Uint8Array(capacity),
    since: new Float32Array(capacity),
    mergeRadius: TEXT_MERGE_PX,
    live: 0,
  };
}

/** Labels are drawn in CSS px, so the merge distance follows the layout's CSS px per arena unit. */
export function setTextScale(t: Texts, cssPxPerUnit: number): void {
  t.mergeRadius = TEXT_MERGE_PX / cssPxPerUnit;
}

/** One squash at x, y: merged into the nearest recent label in reach, or a label of its own. */
export function spawnText(t: Texts, x: number, y: number): void {
  const cap = t.life.length;
  const r2 = t.mergeRadius * t.mergeRadius;
  let near = -1;
  let nearD2 = Infinity;
  let free = -1;
  let weakest = 0;
  for (let i = 0; i < cap; i++) {
    const life = t.life[i]!;
    if (life <= 0) {
      if (free < 0) free = i;
      continue;
    }
    if (life < t.life[weakest]! || t.life[weakest]! <= 0) weakest = i;
    if (t.since[i]! >= TEXT_MERGE_SECONDS || t.count[i]! >= TEXT_MAX_SQUASHES) continue;
    const dx = t.x[i]! - x;
    const dy = t.y[i]! - y;
    const d2 = dx * dx + dy * dy;
    if (d2 <= r2 && d2 < nearD2) {
      near = i;
      nearD2 = d2;
    }
  }
  if (near >= 0) {
    // Its position stays put: moving it to each squash would make it jump.
    t.count[near]!++;
    t.life[near] = TEXT_SECONDS;
    t.since[near] = 0;
    return;
  }
  const i = free >= 0 ? free : weakest;
  if (free >= 0) t.live++;
  t.x[i] = x;
  t.y[i] = y;
  t.life[i] = TEXT_SECONDS;
  t.count[i] = 1;
  t.since[i] = 0;
}

export function updateTexts(t: Texts, dt: number): void {
  if (t.live === 0) return;
  const cap = t.life.length;
  for (let i = 0; i < cap; i++) {
    if (t.life[i]! <= 0) continue;
    t.y[i]! -= TEXT_RISE * dt;
    t.since[i]! += dt;
    t.life[i]! -= dt;
    if (t.life[i]! <= 0) {
      t.life[i] = 0;
      t.live--;
    }
  }
}
