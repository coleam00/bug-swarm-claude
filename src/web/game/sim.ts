// The game itself: pure and time-stepped. It never reads a clock, Math.random or the DOM; time
// comes in as `dt` and randomness from the seeded generator in the state, so `bun test` can
// play it with fixed inputs and the same seed always plays the same run.
import { CI_DRONE, POINTS_PER_SECOND, POINTS_PER_SQUASH, REFACTOR_BOMB, REVIEW_LASER, TEST_SHIELD, UPGRADE_IDS, UPGRADE_MAX_LEVEL, type UpgradeId } from "../../server/rules";
import type { Arena } from "./arena";
import {
  BASE_BUG,
  BOMB_RECHARGE,
  BOMB_RING_SECONDS,
  BUG_KINDS,
  CHOICE_CARDS,
  CHOICE_EVERY,
  DRONE_COUNT,
  DRONE_FIRE_INTERVAL,
  DRONE_ORBIT,
  DRONE_RANGE,
  DRONE_SHOT_LIFETIME,
  DRONE_SPIN,
  FIRE_INTERVAL,
  INVULN_SECONDS,
  LASER_PIERCE,
  MAX_BUGS,
  MAX_HITS,
  MOVING_FIRE_RATE,
  ROBOT_RADIUS,
  ROBOT_SPEED,
  SHIELD_CHARGES,
  SHOT_LIFETIME,
  SHOT_SPEED,
  STRESS_SECONDS,
  spawnInterval,
  type BugKind,
} from "./config";
import { createRng, nextRandom, type Rng } from "./rng";

// The server's squash cap (MAX_SQUASHES_PER_SECOND in rules.ts): a squash takes a bug, so
// squashes never exceed bugs spawned, and bugs spawn at most once every SPAWN_MIN seconds of run
// time. Run time never runs ahead of the server's clock (a choice pauses the run, which only
// adds real time), so a run squashes at most 1 / SPAWN_MIN bugs a second whatever shots
// pierce, bombs clear and however many drones fire. A test in sim.test.ts holds that under the cap.
// A stress run (`createState`'s `stress`) is exempt: it refills the swarm every step, and it is
// never submitted.

export type Input = { kind: "none" } | { kind: "direction"; dx: number; dy: number } | { kind: "target"; x: number; y: number };

export type Bug = { x: number; y: number; hp: number; kind: BugKind };
export type Shot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  /** Bugs this shot may still pass through (review laser). */
  pierce: number;
  /** Bugs it already struck, so a piercing shot hits each bug once. */
  hit: Bug[];
  /** Fired by a CI drone rather than the robot's gun (drawn in the drone's colour). */
  drone: boolean;
};

export type State = {
  arena: Arena;
  rng: Rng;
  /** Draws the upgrade cards. Its own generator, so taking a choice never changes the swarm. */
  drawRng: Rng;
  /** Each upgrade's level: 0 not taken, up to UPGRADE_MAX_LEVEL. */
  levels: Record<UpgradeId, number>;
  /** The upgrades taken, in pick order, repeats included. */
  taken: UpgradeId[];
  /** The cards on offer while the run waits for a choice; null while it plays. */
  choice: UpgradeId[] | null;
  /** The run time of the next choice. */
  nextChoiceAt: number;
  robot: { x: number; y: number };
  bugs: Bug[];
  shots: Shot[];
  /** Seconds survived. */
  time: number;
  spawnTimer: number;
  fireTimer: number;
  /** Where the drones are around their orbit, in radians (CI drone). */
  droneAngle: number;
  /** Each drone's reload, by drone; only the first DRONE_COUNT of them are in use. */
  droneTimers: number[];
  /** Seconds of invulnerability left after a hit or a blocked hit. */
  invuln: number;
  hits: number;
  /** Hits the test shield's bubble will still block. */
  shield: number;
  /** Hits the bubble has blocked so far (fx/changes.ts tells a pop from a squash by it). */
  blocks: number;
  squashes: number;
  /** Run time of the refactor bomb's last blast; -Infinity before the first, so it starts charged. */
  bombAt: number;
  /** Bugs spawned so far (for tests and tuning). */
  spawned: number;
  /**
   * Stress mode (dev and bench only, never submitted): the swarm held at this many bugs, every
   * upgrade at its top level, a robot that can't lose, and a run that ends at STRESS_SECONDS.
   * 0 in normal play.
   */
  stress: number;
  over: boolean;
};

/** Mixed into the run's seed for the card draw, so it isn't the swarm's sequence. */
const DRAW_SEED_MIX = 0x9e3779b9;
const TAU = Math.PI * 2;

/**
 * A new run. `stress` > 0 (clamped to 1..MAX_BUGS) makes it a stress run for measuring the frame
 * rate: see `State.stress`.
 */
export function createState(seed: number, arena: Arena, stress = 0): State {
  const state: State = {
    arena: { w: arena.w, h: arena.h },
    rng: createRng(seed),
    drawRng: createRng((seed ^ DRAW_SEED_MIX) | 0),
    levels: Object.fromEntries(UPGRADE_IDS.map((id) => [id, 0])) as Record<UpgradeId, number>,
    taken: [],
    choice: null,
    nextChoiceAt: CHOICE_EVERY,
    robot: { x: arena.w / 2, y: arena.h / 2 },
    bugs: [],
    shots: [],
    time: 0,
    spawnTimer: spawnInterval(0),
    fireTimer: 0,
    droneAngle: 0,
    // Two drones start half an interval apart rather than firing as one (they can fall into step).
    droneTimers: [0, DRONE_FIRE_INTERVAL / 2],
    invuln: 0,
    hits: 0,
    shield: 0,
    blocks: 0,
    squashes: 0,
    bombAt: -Infinity,
    spawned: 0,
    stress: Math.max(0, Math.min(MAX_BUGS, Math.floor(stress) || 0)),
    over: false,
  };
  if (state.stress > 0) {
    for (const id of UPGRADE_IDS) {
      state.levels[id] = UPGRADE_MAX_LEVEL;
      for (let i = 0; i < UPGRADE_MAX_LEVEL; i++) state.taken.push(id);
    }
    state.shield = SHIELD_CHARGES[UPGRADE_MAX_LEVEL];
    state.nextChoiceAt = Infinity;
  }
  return state;
}

/** What a finished run reports to the server. */
export type RunResult = {
  score: number;
  squashes: number;
  seconds: number;
  touch: boolean;
  /** The upgrades taken, in pick order. */
  upgrades: UpgradeId[];
};

/** The run's finish: its score, squashes, seconds and upgrades, and whether it was played by touch. */
export function runResult(state: State, touch: boolean): RunResult {
  return { score: score(state), squashes: state.squashes, seconds: state.time, touch, upgrades: [...state.taken] };
}

/** 10 per squash plus 1 per whole second survived. */
export function score(state: State): number {
  return POINTS_PER_SQUASH * state.squashes + POINTS_PER_SECOND * Math.floor(state.time);
}

/**
 * Advances the run by `dt` seconds. Mutates `state`; does nothing once the run is over, or
 * while a choice waits (`state.choice`), so the pause never counts as time survived.
 */
export function step(state: State, input: Input, dt: number): void {
  if (state.over || state.choice) return;
  // First, so it never clears a bug in the step that bug spawned.
  refactorBomb(state);
  const moved = moveRobot(state, input, dt);
  if (state.stress === 0) spawnBugs(state, dt);
  moveBugs(state, dt);
  fire(state, dt, moved);
  fireDrones(state, dt);
  moveShots(state, dt);
  hitBugs(state);
  hitRobot(state, dt);
  state.time += dt;
  if (state.stress > 0) {
    // Last, so every step ends with the full swarm, the one after a blast too.
    while (state.bugs.length < state.stress) spawnOne(state, Infinity);
    if (state.time >= STRESS_SECONDS - 1e-9) state.over = true;
    return;
  }
  if (!state.over && state.time >= state.nextChoiceAt - 1e-9) offerChoice(state);
}

/** Every CHOICE_EVERY seconds: up to CHOICE_CARDS different upgrades not yet at their top level. */
function offerChoice(state: State): void {
  state.nextChoiceAt += CHOICE_EVERY;
  const pool = UPGRADE_IDS.filter((id) => state.levels[id] < UPGRADE_MAX_LEVEL);
  if (pool.length === 0) return;
  const cards = Math.min(CHOICE_CARDS, pool.length);
  // A partial Fisher-Yates: the first `cards` of the pool, shuffled.
  for (let i = 0; i < cards; i++) {
    const j = i + Math.floor(nextRandom(state.drawRng) * (pool.length - i));
    const t = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = t;
  }
  state.choice = pool.slice(0, cards);
}

/**
 * Takes card `index` of the choice on offer: that upgrade goes up a level and the run resumes.
 * Returns false, changing nothing, when no choice waits or there is no such card.
 */
export function choose(state: State, index: number): boolean {
  const cards = state.choice;
  if (!cards || !Number.isInteger(index) || index < 0 || index >= cards.length) return false;
  const id = cards[index]!;
  state.levels[id]++;
  if (id === TEST_SHIELD) state.shield = SHIELD_CHARGES[state.levels[id]]!;
  state.taken.push(id);
  state.choice = null;
  return true;
}

/** Moves the robot and says whether it moved this step (pushing into a wall is not moving). */
function moveRobot(state: State, input: Input, dt: number): boolean {
  const r = state.robot;
  const fromX = r.x;
  const fromY = r.y;
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
  return r.x !== fromX || r.y !== fromY;
}

function spawnBugs(state: State, dt: number): void {
  state.spawnTimer -= dt;
  while (state.spawnTimer <= 0) {
    state.spawnTimer += spawnInterval(state.time);
    if (state.bugs.length >= MAX_BUGS) continue;
    spawnOne(state, state.time);
  }
}

/** Spawns one bug just outside a random edge, of a kind due `time` seconds into a run. */
function spawnOne(state: State, time: number): void {
  const { w, h } = state.arena;
  const edge = Math.floor(nextRandom(state.rng) * 4);
  const along = nextRandom(state.rng);
  // Just outside the chosen edge: 0 top, 1 right, 2 bottom, 3 left.
  // The kind takes a draw only once a later kind can appear, so the opening of a run plays
  // the same whatever kinds come later.
  const kind = laterKindDue(time) ? pickKind(time, nextRandom(state.rng)) : BASE_BUG;
  const r = kind.radius;
  const x = edge === 1 ? w + r : edge === 3 ? -r : along * w;
  const y = edge === 0 ? -r : edge === 2 ? h + r : along * h;
  state.bugs.push({ x, y, hp: kind.hp, kind });
  state.spawned++;
}

function laterKindDue(time: number): boolean {
  for (let i = 1; i < BUG_KINDS.length; i++) if (BUG_KINDS[i]!.from <= time) return true;
  return false;
}

/**
 * The kind of bug a spawn `time` seconds into a run is, for a `roll` in [0, 1). Each kind that
 * has started takes its share of rolls; the base kind takes the rest.
 */
export function pickKind(time: number, roll: number): BugKind {
  let upTo = 0;
  for (let i = 1; i < BUG_KINDS.length; i++) {
    const kind = BUG_KINDS[i]!;
    if (kind.from > time) continue;
    upTo += kind.share;
    if (roll < upTo) return kind;
  }
  return BASE_BUG;
}

function moveBugs(state: State, dt: number): void {
  const { x: rx, y: ry } = state.robot;
  for (const b of state.bugs) {
    const reach = b.kind.speed * dt;
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

/**
 * The refactor bomb goes off on its own: once charged, on the first step that starts with a
 * bug in the arena, it clears every bug (each one a squash) and starts recharging. It keeps
 * its charge while the arena is empty. Taking it again shortens the recharge from the last blast.
 */
function refactorBomb(state: State): void {
  const level = state.levels[REFACTOR_BOMB];
  if (level === 0 || state.bugs.length === 0) return;
  if (state.time - state.bombAt < BOMB_RECHARGE[level]! - 1e-9) return;
  state.squashes += state.bugs.length;
  state.bugs.length = 0;
  state.bombAt = state.time;
}

/** The refactor bomb's charge, 0 just after a blast to 1 ready; 0 while it isn't taken. */
export function bombCharge(state: State): number {
  const level = state.levels[REFACTOR_BOMB];
  if (level === 0) return 0;
  return Math.min(1, (state.time - state.bombAt) / BOMB_RECHARGE[level]!);
}

/** How far the last blast's ring has swept, in [0, 1); -1 when no ring is showing. */
export function bombRing(state: State): number {
  const age = state.time - state.bombAt;
  return age < BOMB_RING_SECONDS ? age / BOMB_RING_SECONDS : -1;
}

/** Auto-fire at the nearest bug. The gun reloads faster while the robot moves. */
function fire(state: State, dt: number, moved: boolean): void {
  state.fireTimer -= moved ? dt * MOVING_FIRE_RATE : dt;
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
  const pierce = LASER_PIERCE[state.levels[REVIEW_LASER]]!;
  state.shots.push({ x: rx, y: ry, vx, vy, life: SHOT_LIFETIME, pierce, hit: [], drone: false });
  state.fireTimer += FIRE_INTERVAL;
}

/** How many drones orbit the robot: none until the CI drone is taken. */
export function droneCount(state: State): number {
  return DRONE_COUNT[state.levels[CI_DRONE]]!;
}

/** Drone `i`'s position: on its orbit around the robot, spaced evenly with the others. */
export function droneX(state: State, i: number): number {
  return state.robot.x + Math.cos(state.droneAngle + (i * TAU) / droneCount(state)) * DRONE_ORBIT;
}

export function droneY(state: State, i: number): number {
  return state.robot.y + Math.sin(state.droneAngle + (i * TAU) / droneCount(state)) * DRONE_ORBIT;
}

/**
 * CI drone: each drone turns on its orbit and, on its own reload, fires at the nearest bug
 * within DRONE_RANGE of itself. Its shots never pierce: the review laser is the gun's.
 */
function fireDrones(state: State, dt: number): void {
  const count = droneCount(state);
  if (count === 0) return;
  state.droneAngle = (state.droneAngle + DRONE_SPIN * dt) % TAU;
  const timers = state.droneTimers;
  for (let i = 0; i < count; i++) {
    timers[i]! -= dt;
    if (timers[i]! > 0) continue;
    const x = droneX(state, i);
    const y = droneY(state, i);
    let nearest: Bug | undefined;
    let best = DRONE_RANGE * DRONE_RANGE;
    for (const b of state.bugs) {
      const d = (b.x - x) ** 2 + (b.y - y) ** 2;
      if (d <= best) {
        best = d;
        nearest = b;
      }
    }
    if (!nearest) {
      timers[i] = 0; // ready the moment a bug comes in range
      continue;
    }
    const dist = Math.sqrt(best) || 1;
    const vx = ((nearest.x - x) / dist) * SHOT_SPEED;
    const vy = ((nearest.y - y) / dist) * SHOT_SPEED;
    state.shots.push({ x, y, vx, vy, life: DRONE_SHOT_LIFETIME, pierce: 0, hit: [], drone: true });
    timers[i]! += DRONE_FIRE_INTERVAL;
  }
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
  for (let i = shots.length - 1; i >= 0; i--) {
    const s = shots[i]!;
    for (let j = 0; j < bugs.length; j++) {
      const b = bugs[j]!;
      if ((b.x - s.x) ** 2 + (b.y - s.y) ** 2 > b.kind.radius ** 2) continue;
      // A piercing shot overlaps a bug for a step or two, and two at once in a clump.
      if (s.hit.includes(b)) continue;
      // One bug a step: a piercing shot moves on and meets the next on a later step.
      if (s.pierce > 0) {
        s.pierce--;
        s.hit.push(b);
      } else {
        removeAt(shots, i);
      }
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
  const bugs = state.bugs;
  for (let j = 0; j < bugs.length; j++) {
    const b = bugs[j]!;
    if ((b.x - rx) ** 2 + (b.y - ry) ** 2 > (ROBOT_RADIUS + b.kind.radius) ** 2) continue;
    removeAt(bugs, j);
    // The bubble takes the hit: the bug is gone, no life is lost, and the same safe window
    // follows, so a clump can't pop both charges (or a charge and a life) at once.
    if (state.shield > 0) {
      state.shield--;
      state.blocks++;
      state.invuln = INVULN_SECONDS;
      return;
    }
    state.hits++;
    state.invuln = INVULN_SECONDS;
    // A stress run can't lose; its bubble comes back after each hit it lets through, so the
    // shake, the pop and the bubble all keep drawing.
    if (state.stress > 0) state.shield = SHIELD_CHARGES[state.levels[TEST_SHIELD]]!;
    else if (state.hits >= MAX_HITS) state.over = true;
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
