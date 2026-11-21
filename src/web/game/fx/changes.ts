// What happened since the last frame, worked out by comparing the bug list with the one before
// it. The simulation only counts squashes and hits, but a bug object keeps its identity until
// it is removed, so a bug that vanished was either squashed by a shot or hit the robot (when
// the hit counter went up, the vanished bug closest to the robot is taken as the hit). It also
// keeps a steady animation phase per bug, so the swarm's legs don't all step in time.
// Pure (no DOM, no canvas); it reads the state and never changes it.
import { nextRandom, type Rng } from "../rng";
import { MAX_BUGS } from "../config";
import type { Bug, State } from "../sim";

export type Changes = {
  /** The bugs as of the last call. */
  prev: Bug[];
  /** A phase in [0, 1) per bug, in the same order as `state.bugs` after the last call. */
  phase: Float32Array;
  /** Scratch for the next call's phases (swapped with `phase`). */
  nextPhase: Float32Array;
  /** Per bug in `prev`: 0 vanished, 1 still alive, 2 vanished and taken as the hit. */
  seen: Uint8Array;
  hits: number;
  /** fx's own generator; never the simulation's. */
  rng: Rng;
};

/** Gets the squashed bug itself: its position is where it was when the shot landed. */
export type OnSquash = (bug: Bug) => void;
export type OnHit = (x: number, y: number) => void;

export function createChanges(rng: Rng, capacity = MAX_BUGS): Changes {
  return {
    prev: [],
    phase: new Float32Array(capacity),
    nextPhase: new Float32Array(capacity),
    seen: new Uint8Array(capacity),
    hits: 0,
    rng,
  };
}

/**
 * Calls `onSquash` with each bug squashed since the last call, and
 * `onHit` at the robot for each hit. Call once a frame, after the steps. Allocates nothing.
 */
export function detectChanges(c: Changes, state: State, onSquash: OnSquash, onHit: OnHit): void {
  const prev = c.prev;
  const bugs = state.bugs;
  const seen = c.seen;
  const phase = c.phase;
  const next = c.nextPhase;
  seen.fill(0, 0, prev.length);

  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i]!;
    let j = 0;
    while (j < prev.length && prev[j] !== b) j++;
    if (j < prev.length) {
      seen[j] = 1;
      next[i] = phase[j]!;
    } else {
      next[i] = nextRandom(c.rng);
    }
  }

  const { x: rx, y: ry } = state.robot;
  for (let h = c.hits; h < state.hits; h++) {
    let hit = -1;
    let best = Infinity;
    for (let j = 0; j < prev.length; j++) {
      if (seen[j] !== 0) continue;
      const d = (prev[j]!.x - rx) ** 2 + (prev[j]!.y - ry) ** 2;
      if (d < best) {
        best = d;
        hit = j;
      }
    }
    if (hit >= 0) seen[hit] = 2;
    onHit(rx, ry);
  }

  for (let j = 0; j < prev.length; j++) {
    if (seen[j] === 0) onSquash(prev[j]!);
  }

  prev.length = bugs.length;
  for (let i = 0; i < bugs.length; i++) prev[i] = bugs[i]!;
  c.phase = next;
  c.nextPhase = phase;
  c.hits = state.hits;
}
