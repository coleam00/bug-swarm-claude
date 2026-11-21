// Scripted players (#55): the policies `bun run skill` measures and `bun run bots` plays with.
// A policy reads an Observation (filled in-process by `observe`, or by bots from snapshots) and
// writes one tick's input. Pure: randomness comes from the rng it is handed, never the arena's.
//
// The specs below are fixed. Tuning the game changes constants.ts only, never these: a gate that
// fails is not passed by weakening the mover (engineering.md, "Skill is measured").
//
// - idle: never moves, never fires.
// - mover: runs from bugs and fires straight ahead. Its move is the threat vector, the sum over
//   bugs within THREAT_RANGE of (self - bug) / d^2, plus a push off any wall within WALL_RANGE;
//   with no threat it drifts toward the centre. The move is normalised to full speed. It aims
//   where it moves (keeping its last aim while still) and holds fire all the time, so its gun
//   overheats and locks. No reaction delay, perfect information.
// - aimer: the same evasion as the mover, but only while the nearest bug is within KEEP_DIST;
//   otherwise it strafes slowly across the nearest bug's line, keeping its distance. It aims
//   where the nearest bug within AIM_RANGE will be (leading it with SHOT_SPEED from the barrel)
//   and fires in bursts: while heat is under BURST_HEAT and fewer than BURST_SHOTS have left,
//   then it releases for BURST_REST_S. It never fires while locked or with no bug in range.
//
// Every policy presses dash while out, so it respawns.
import { BARREL, DT, SHOT_SPEED } from "./constants";
import { nextRandom, type Rng } from "./rng";
import type { ArenaState } from "./sim";

export const POLICY_NAMES = ["idle", "mover", "aimer"] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];
export const [IDLE, MOVER, AIMER] = POLICY_NAMES;

export type ObservedBug = { x: number; y: number; vx: number; vy: number };

export type Observation = {
  self: { x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; heat: number; locked: boolean };
  /** Every bug the policy knows about. Only the first `bugCount` entries are current. */
  bugs: ObservedBug[];
  bugCount: number;
  world: { w: number; h: number };
};

export type PolicyInput = { mx: number; my: number; aim: number; fire: boolean; dash: boolean };

/** What a policy remembers between ticks. */
export type PolicyMemory = {
  /** The last aim, kept while still. */
  aim: number;
  /** Shots fired in the current burst. */
  burst: number;
  /** Seconds left resting between bursts. */
  rest: number;
  /** The heat last tick: a rise means a shot left. */
  lastHeat: number;
  /** Strafe direction, 1 or -1. */
  strafe: number;
  /** Seconds until the strafe may flip. */
  strafeFor: number;
};

export type Policy = (obs: Observation, mem: PolicyMemory, rng: Rng, out: PolicyInput) => void;

/** Bugs within this range count as a threat, units. */
export const THREAT_RANGE = 400;
/** Walls within this range push the evasion away, units. */
export const WALL_RANGE = 150;
/** The aimer evades only while the nearest bug is closer than this, units. */
export const KEEP_DIST = 260;
/** The aimer shoots only at a bug within this range, units. */
export const AIM_RANGE = 650;
/** The aimer's burst: at most this many shots... */
export const BURST_SHOTS = 5;
/** ...and only while heat is under this... */
export const BURST_HEAT = 0.7;
/** ...then it releases the trigger this long, seconds. */
export const BURST_REST_S = 0.3;
/** The aimer's strafe speed, a fraction of full speed. */
export const STRAFE = 0.35;

export function createMemory(): PolicyMemory {
  return { aim: 0, burst: 0, rest: 0, lastHeat: 0, strafe: 1, strafeFor: 0 };
}

export function createObservation(): Observation {
  return {
    self: { x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: false, heat: 0, locked: false },
    bugs: [],
    bugCount: 0,
    world: { w: 0, h: 0 },
  };
}

/** Sets the observed bug at index `i`, growing the list only when it must. */
export function setObservedBug(obs: Observation, i: number, x: number, y: number, vx: number, vy: number): void {
  const b = obs.bugs[i];
  if (b) {
    b.x = x;
    b.y = y;
    b.vx = vx;
    b.vy = vy;
  } else obs.bugs[i] = { x, y, vx, vy };
}

/** Fills `out` with what player `playerId` sees in `state` (everything: perfect information). */
export function observe(state: ArenaState, playerId: number, w: number, h: number, out: Observation): Observation {
  const p = state.players.find((q) => q.id === playerId);
  const s = out.self;
  if (p) {
    s.x = p.x;
    s.y = p.y;
    s.vx = p.vx;
    s.vy = p.vy;
    s.aim = p.aim;
    s.alive = p.alive;
    s.heat = p.heat;
    s.locked = p.lockTicks > 0;
  } else s.alive = false;
  out.bugCount = state.bugs.length;
  for (let i = 0; i < state.bugs.length; i++) {
    const b = state.bugs[i]!;
    setObservedBug(out, i, b.x, b.y, b.vx, b.vy);
  }
  out.world.w = w;
  out.world.h = h;
  return out;
}

function nearestBug(obs: Observation): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < obs.bugCount; i++) {
    const b = obs.bugs[i]!;
    const d = (b.x - obs.self.x) ** 2 + (b.y - obs.self.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const evade = { x: 0, y: 0, threat: false };

/**
 * The shared evasion: the threat vector plus the wall push, into `evade` (unnormalised). The
 * mover and the aimer both use it, so the skill gate measures aiming, not running.
 */
function evasion(obs: Observation): void {
  const { x, y } = obs.self;
  let ex = 0;
  let ey = 0;
  let threat = false;
  for (let i = 0; i < obs.bugCount; i++) {
    const b = obs.bugs[i]!;
    const dx = x - b.x;
    const dy = y - b.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > THREAT_RANGE * THREAT_RANGE || d2 === 0) continue;
    ex += dx / d2;
    ey += dy / d2;
    threat = true;
  }
  const { w, h } = obs.world;
  const wall = (d: number) => (d < WALL_RANGE ? 1 / Math.max(d, 1) - 1 / WALL_RANGE : 0);
  ex += wall(x) - wall(w - x);
  ey += wall(y) - wall(h - y);
  evade.x = ex;
  evade.y = ey;
  evade.threat = threat;
}

/** Writes (x, y) normalised to length `speed` into out.mx/my, or zero for a zero vector. */
function moveAlong(out: PolicyInput, x: number, y: number, speed: number): void {
  const d = Math.hypot(x, y);
  if (d < 1e-12) {
    out.mx = 0;
    out.my = 0;
  } else {
    out.mx = (x / d) * speed;
    out.my = (y / d) * speed;
  }
}

function still(out: PolicyInput): void {
  out.mx = 0;
  out.my = 0;
  out.fire = false;
}

export const idle: Policy = (obs, mem, _rng, out) => {
  still(out);
  out.aim = mem.aim;
  out.dash = !obs.self.alive;
};

export const mover: Policy = (obs, mem, _rng, out) => {
  out.dash = !obs.self.alive;
  if (!obs.self.alive) return still(out);
  evasion(obs);
  let mx = evade.x;
  let my = evade.y;
  if (!evade.threat) {
    // Drift toward the centre, as a small pull the wall push still outweighs.
    const cx = obs.world.w / 2 - obs.self.x;
    const cy = obs.world.h / 2 - obs.self.y;
    const d = Math.hypot(cx, cy);
    if (d > 100) {
      mx += cx / d / THREAT_RANGE;
      my += cy / d / THREAT_RANGE;
    }
  }
  moveAlong(out, mx, my, 1);
  if (out.mx !== 0 || out.my !== 0) mem.aim = Math.atan2(out.my, out.mx);
  out.aim = mem.aim;
  out.fire = true;
};

/** The time a shot from (sx, sy) takes to meet a bug at (bx, by) moving (vx, vy); -1 if never. */
function intercept(sx: number, sy: number, bx: number, by: number, vx: number, vy: number): number {
  const dx = bx - sx;
  const dy = by - sy;
  const a = vx * vx + vy * vy - SHOT_SPEED * SHOT_SPEED;
  const b = 2 * (dx * vx + dy * vy);
  const c = dx * dx + dy * dy;
  if (Math.abs(a) < 1e-9) return b < 0 ? -c / b : -1;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const r = Math.sqrt(disc);
  const t1 = (-b - r) / (2 * a);
  const t2 = (-b + r) / (2 * a);
  const t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  return t > 0 ? t : -1;
}

export const aimer: Policy = (obs, mem, rng, out) => {
  out.dash = !obs.self.alive;
  if (!obs.self.alive) {
    mem.burst = 0;
    mem.rest = 0;
    mem.lastHeat = 0;
    return still(out);
  }
  const { x, y } = obs.self;
  if (obs.self.heat > mem.lastHeat + 1e-6) mem.burst++;
  mem.lastHeat = obs.self.heat;
  const n = nearestBug(obs);
  const near = n >= 0 ? obs.bugs[n]! : null;
  const dist = near ? Math.hypot(near.x - x, near.y - y) : Infinity;

  // Move: evade when close, else strafe across the nearest bug's line, keeping off the walls.
  evasion(obs);
  if (near && dist < KEEP_DIST) moveAlong(out, evade.x, evade.y, 1);
  else if (near) {
    mem.strafeFor -= DT;
    if (mem.strafeFor <= 0) {
      mem.strafe = nextRandom(rng) < 0.5 ? -1 : 1;
      mem.strafeFor = 1 + nextRandom(rng) * 2;
    }
    const px = (-(near.y - y) / dist) * mem.strafe;
    const py = ((near.x - x) / dist) * mem.strafe;
    moveAlong(out, px / THREAT_RANGE + evade.x, py / THREAT_RANGE + evade.y, STRAFE);
  } else moveAlong(out, evade.x, evade.y, STRAFE);

  // Aim: lead the nearest bug in range.
  if (near && dist <= AIM_RANGE) {
    const ux = (near.x - x) / dist;
    const uy = (near.y - y) / dist;
    const sx = x + ux * BARREL;
    const sy = y + uy * BARREL;
    const t = intercept(sx, sy, near.x, near.y, near.vx, near.vy);
    const tx = t > 0 ? near.x + near.vx * t : near.x;
    const ty = t > 0 ? near.y + near.vy * t : near.y;
    mem.aim = Math.atan2(ty - y, tx - x);
  }
  out.aim = mem.aim;

  // Fire: bursts under the heat limit.
  if (mem.rest > 0) {
    mem.rest -= DT;
    out.fire = false;
    return;
  }
  const canFire = near !== null && dist <= AIM_RANGE && !obs.self.locked;
  if (canFire && obs.self.heat < BURST_HEAT && mem.burst < BURST_SHOTS) {
    out.fire = true;
    return;
  }
  out.fire = false;
  if (mem.burst > 0) {
    mem.burst = 0;
    mem.rest = BURST_REST_S;
  }
};

export const POLICIES: Record<PolicyName, Policy> = { idle, mover, aimer };
