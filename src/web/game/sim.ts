// The game itself: pure and time-stepped. It never reads a clock, Math.random or the DOM; time
// comes in as `dt` and randomness from the seeded generator in the state, so `bun test` can
// play it with fixed inputs and the same seed always plays the same run.
import { POINTS_PER_SECOND, POINTS_PER_SQUASH } from "../../server/rules";
import type { Arena } from "./arena";
import { createRng, nextRandom, type Rng } from "./rng";

// Tuning (Phase 2 adds the ramp). Distances are arena units, times seconds.
export const ROBOT_RADIUS = 14;
export const ROBOT_SPEED = 260;
export const BUG_RADIUS = 12;
export const BUG_SPEED = 90;
export const BUG_HP = 2;
export const FIRE_INTERVAL = 0.25;
export const SHOT_SPEED = 700;
export const SHOT_LIFETIME = 1.0;
export const SPAWN_INTERVAL = 0.48;
export const INVULN_SECONDS = 1.0;
export const MAX_HITS = 3;
export const MAX_BUGS = 200;
// The robot kills at most 1 / (FIRE_INTERVAL * BUG_HP) bugs a second. That must stay below the
// spawn rate (1 / SPAWN_INTERVAL), or an idle player never dies; it also stays far under the
// server's plausibility cap of 6 squashes a second.

export type Input = { kind: "none" } | { kind: "direction"; dx: number; dy: number } | { kind: "target"; x: number; y: number };

export type Bug = { x: number; y: number; hp: number };
export type Shot = { x: number; y: number; vx: number; vy: number; life: number };

export type State = {
  arena: Arena;
  rng: Rng;
  robot: { x: number; y: number };
  bugs: Bug[];
  shots: Shot[];
  /** Seconds survived. */
  time: number;
  spawnTimer: number;
  fireTimer: number;
  /** Seconds of invulnerability left after a hit. */
  invuln: number;
  hits: number;
  squashes: number;
  /** Bugs spawned so far (for tests and tuning). */
  spawned: number;
  over: boolean;
};

export function createState(seed: number, arena: Arena): State {
  return {
    arena: { w: arena.w, h: arena.h },
    rng: createRng(seed),
    robot: { x: arena.w / 2, y: arena.h / 2 },
    bugs: [],
    shots: [],
    time: 0,
    spawnTimer: SPAWN_INTERVAL,
    fireTimer: 0,
    invuln: 0,
    hits: 0,
    squashes: 0,
    spawned: 0,
    over: false,
  };
}

/** 10 per squash plus 1 per whole second survived. */
export function score(state: State): number {
  return POINTS_PER_SQUASH * state.squashes + POINTS_PER_SECOND * Math.floor(state.time);
}

/** Advances the run by `dt` seconds. Mutates `state`; does nothing once the run is over. */
export function step(state: State, input: Input, dt: number): void {
  if (state.over) return;
  moveRobot(state, input, dt);
  spawnBugs(state, dt);
  moveBugs(state, dt);
  fire(state, dt);
  moveShots(state, dt);
  hitBugs(state);
  hitRobot(state, dt);
  state.time += dt;
}

function moveRobot(state: State, input: Input, dt: number): void {
  const r = state.robot;
  const reach = ROBOT_SPEED * dt;
  if (input.kind === "direction") {
    const len = Math.hypot(input.dx, input.dy);
    if (len > 0) {
      r.x += (input.dx / len) * reach;
      r.y += (input.dy / len) * reach;
    }
  } else if (input.kind === "target") {
    const dx = input.x - r.x;
    const dy = input.y - r.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= reach) {
      r.x = input.x;
      r.y = input.y;
    } else {
      r.x += (dx / dist) * reach;
      r.y += (dy / dist) * reach;
    }
  }
  r.x = clamp(r.x, ROBOT_RADIUS, state.arena.w - ROBOT_RADIUS);
  r.y = clamp(r.y, ROBOT_RADIUS, state.arena.h - ROBOT_RADIUS);
}

function spawnBugs(state: State, dt: number): void {
  state.spawnTimer -= dt;
  while (state.spawnTimer <= 0) {
    state.spawnTimer += SPAWN_INTERVAL;
    if (state.bugs.length >= MAX_BUGS) continue;
    const { w, h } = state.arena;
    const edge = Math.floor(nextRandom(state.rng) * 4);
    const along = nextRandom(state.rng);
    // Just outside the chosen edge: 0 top, 1 right, 2 bottom, 3 left.
    const x = edge === 1 ? w + BUG_RADIUS : edge === 3 ? -BUG_RADIUS : along * w;
    const y = edge === 0 ? -BUG_RADIUS : edge === 2 ? h + BUG_RADIUS : along * h;
    state.bugs.push({ x, y, hp: BUG_HP });
    state.spawned++;
  }
}

function moveBugs(state: State, dt: number): void {
  const { x: rx, y: ry } = state.robot;
  const reach = BUG_SPEED * dt;
  for (const b of state.bugs) {
    const dx = rx - b.x;
    const dy = ry - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= reach) {
      b.x = rx;
      b.y = ry;
    } else {
      b.x += (dx / dist) * reach;
      b.y += (dy / dist) * reach;
    }
  }
}

function fire(state: State, dt: number): void {
  state.fireTimer -= dt;
  if (state.fireTimer > 0) return;
  const { x: rx, y: ry } = state.robot;
  let nearest: Bug | undefined;
  let best = Infinity;
  for (const b of state.bugs) {
    const d = (b.x - rx) ** 2 + (b.y - ry) ** 2;
    if (d < best) {
      best = d;
      nearest = b;
    }
  }
  if (!nearest) {
    state.fireTimer = 0; // ready to fire the moment a bug appears
    return;
  }
  const dist = Math.sqrt(best) || 1;
  const vx = ((nearest.x - rx) / dist) * SHOT_SPEED;
  const vy = ((nearest.y - ry) / dist) * SHOT_SPEED;
  state.shots.push({ x: rx, y: ry, vx, vy, life: SHOT_LIFETIME });
  state.fireTimer += FIRE_INTERVAL;
}

function moveShots(state: State, dt: number): void {
  const shots = state.shots;
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i]!;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;
    if (s.life <= 0) removeAt(shots, i);
  }
}

function hitBugs(state: State): void {
  const { shots, bugs } = state;
  const reach2 = BUG_RADIUS * BUG_RADIUS;
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i]!;
    for (let j = 0; j < bugs.length; j++) {
      const b = bugs[j]!;
      if ((b.x - s.x) ** 2 + (b.y - s.y) ** 2 > reach2) continue;
      removeAt(shots, i);
      b.hp--;
      if (b.hp <= 0) {
        removeAt(bugs, j);
        state.squashes++;
      }
      break;
    }
  }
}

function hitRobot(state: State, dt: number): void {
  if (state.invuln > 0) {
    state.invuln = Math.max(0, state.invuln - dt);
    return;
  }
  const { x: rx, y: ry } = state.robot;
  const reach = ROBOT_RADIUS + BUG_RADIUS;
  const bugs = state.bugs;
  for (let j = 0; j < bugs.length; j++) {
    const b = bugs[j]!;
    if ((b.x - rx) ** 2 + (b.y - ry) ** 2 > reach * reach) continue;
    removeAt(bugs, j);
    state.hits++;
    state.invuln = INVULN_SECONDS;
    if (state.hits >= MAX_HITS) state.over = true;
    return;
  }
}

/** Removes an element without shifting the rest (order doesn't matter). */
function removeAt<T>(list: T[], i: number): void {
  const last = list.pop()!;
  if (i < list.length) list[i] = last;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
