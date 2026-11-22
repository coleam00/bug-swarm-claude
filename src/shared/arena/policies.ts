// Scripted players (#55): the policies `bun run skill` measures and `bun run bots` plays with.
// A policy reads an Observation (filled in-process by `observe`, or by bots from snapshots) and
// writes one tick's input. Pure: randomness comes from the rng it is handed, never the arena's.
//
// The specs below are fixed. Tuning the game changes constants.ts, the bug kinds' files (bugs/)
// and the pickups' files (pickups/), never these: a gate that fails is not passed by weakening the
// mover (engineering.md, "Skill is measured"). Going for pickups (#73) was added to the aimer as
// a strength, never to pass a gate.
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
//   Pickups (#73): while the nearest bug is not within KEEP_DIST and a pickup lies within
//   PICKUP_SEEK, it walks to the nearest pickup at full speed instead (aim and fire unchanged).
//   `aimerBase` is the aimer without this.
// - dasher (#60): the aimer, plus the dash. When its dash is ready and a bug is about to touch it
//   (within DASH_CONTACT of touching, now or after one more tick of the bug's velocity), it
//   presses dash along the evasion (its aim when there is none), on that tick only.
//
// - fillBot (#66): the server's fill bots. The aimer without going for pickups (aimerBase, so
//   viewers get them; it still takes one it walks over), with a human layer on top: when its target
//   changes (its aim jumps by more than FILL_RETARGET) or a bug comes inside KEEP_DIST, it reacts
//   only after FILL_REACT_MIN_TICKS to FILL_REACT_MAX_TICKS (drawn per reaction), keeping its last
//   move and holding fire meanwhile; its aim turns at most FILL_TURN_RATE toward the aimer's plus a
//   slow wobble of up to FILL_WOBBLE, and it fires only while that aim is within FILL_FIRE_CONE of
//   the aimer's. It walks to the nearest downed player within FILL_REVIVE_SEEK, bugs or not, and
//   stands still within FILL_REVIVE_STAND of them (still shooting), so it revives people it
//   passes near, in a swarm too. Not in POLICY_NAMES: `bun run skill` reports it on its own
//   line, never in a gate.
//
// Every policy presses dash while out, so it respawns; only the dasher presses it in a life. The
// idle and the mover never go for pickups; they take one only when they walk over it.
import { MAX_BUG_RADIUS } from "./bugs/registry";
import { BARREL, DT, PLAYER_RADIUS, REVIVE_RANGE, SHOT_SPEED } from "./constants";
import { nextRandom, type Rng } from "./rng";
import { wrapAngle, type ArenaState } from "./sim";

export const POLICY_NAMES = ["idle", "mover", "aimer", "dasher"] as const;
export type PolicyName = (typeof POLICY_NAMES)[number];
export const [IDLE, MOVER, AIMER, DASHER] = POLICY_NAMES;

export type ObservedBug = { x: number; y: number; vx: number; vy: number };

export type Observation = {
  self: { x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; heat: number; locked: boolean; dashReady: boolean };
  /** Every bug the policy knows about. Only the first `bugCount` entries are current. */
  bugs: ObservedBug[];
  bugCount: number;
  /** Every other player who is down. Only the first `downCount` entries are current. */
  downs: { x: number; y: number }[];
  downCount: number;
  /** Every pickup on the floor (#73). Only the first `pickupCount` entries are current. */
  pickups: { x: number; y: number }[];
  pickupCount: number;
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
/** The dasher dashes when a bug is this close to touching it, units (centre gap minus both radii). */
export const DASH_CONTACT = 30;
/** The aimer walks to a pickup within this, units, when no bug is within KEEP_DIST (#73). */
export const PICKUP_SEEK = 300;

export function createMemory(): PolicyMemory {
  return { aim: 0, burst: 0, rest: 0, lastHeat: 0, strafe: 1, strafeFor: 0 };
}

export function createObservation(): Observation {
  return {
    self: { x: 0, y: 0, vx: 0, vy: 0, aim: 0, alive: false, heat: 0, locked: false, dashReady: false },
    bugs: [],
    bugCount: 0,
    downs: [],
    downCount: 0,
    pickups: [],
    pickupCount: 0,
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

/** Sets the observed pickup at index `i`, growing the list only when it must. */
export function setObservedPickup(obs: Observation, i: number, x: number, y: number): void {
  const f = obs.pickups[i];
  if (f) {
    f.x = x;
    f.y = y;
  } else obs.pickups[i] = { x, y };
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
    s.dashReady = p.alive && p.dashCooldown === 0 && p.dashTicks === 0;
  } else {
    s.alive = false;
    s.dashReady = false;
  }
  out.bugCount = state.bugs.length;
  for (let i = 0; i < state.bugs.length; i++) {
    const b = state.bugs[i]!;
    setObservedBug(out, i, b.x, b.y, b.vx, b.vy);
  }
  let downs = 0;
  for (const q of state.players) {
    if (q.id === playerId || !q.alive || !q.down) continue;
    const d = out.downs[downs];
    if (d) {
      d.x = q.x;
      d.y = q.y;
    } else out.downs[downs] = { x: q.x, y: q.y };
    downs++;
  }
  out.downCount = downs;
  out.pickupCount = state.floor.length;
  for (let i = 0; i < state.floor.length; i++) setObservedPickup(out, i, state.floor[i]!.x, state.floor[i]!.y);
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

/** The aimer without going for pickups: what the fill bot builds on. */
export const aimerBase: Policy = (obs, mem, rng, out) => {
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

/**
 * The aimer: aimerBase, then, while up with no bug within KEEP_DIST, a walk at full speed to the
 * nearest pickup within PICKUP_SEEK (its aim and fire stay aimerBase's).
 */
export const aimer: Policy = (obs, mem, rng, out) => {
  aimerBase(obs, mem, rng, out);
  if (!obs.self.alive || obs.pickupCount === 0) return;
  const { x, y } = obs.self;
  const n = nearestBug(obs);
  if (n >= 0) {
    const b = obs.bugs[n]!;
    if ((b.x - x) ** 2 + (b.y - y) ** 2 < KEEP_DIST * KEEP_DIST) return;
  }
  let best = -1;
  let bestD = PICKUP_SEEK * PICKUP_SEEK;
  for (let i = 0; i < obs.pickupCount; i++) {
    const f = obs.pickups[i]!;
    const d = (f.x - x) ** 2 + (f.y - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return;
  const f = obs.pickups[best]!;
  moveAlong(out, f.x - x, f.y - y, 1);
};

/** Whether a bug is within DASH_CONTACT of touching the policy's robot, now or one tick on. */
function aboutToTouch(obs: Observation): boolean {
  const { x, y } = obs.self;
  const reach = PLAYER_RADIUS + MAX_BUG_RADIUS + DASH_CONTACT;
  const r2 = reach * reach;
  for (let i = 0; i < obs.bugCount; i++) {
    const b = obs.bugs[i]!;
    if ((b.x - x) ** 2 + (b.y - y) ** 2 < r2) return true;
    if ((b.x + b.vx * DT - x) ** 2 + (b.y + b.vy * DT - y) ** 2 < r2) return true;
  }
  return false;
}

export const dasher: Policy = (obs, mem, rng, out) => {
  aimer(obs, mem, rng, out);
  if (!obs.self.alive || !obs.self.dashReady || !aboutToTouch(obs)) return;
  evasion(obs);
  moveAlong(out, evade.x, evade.y, 1);
  out.dash = true;
};

export const POLICIES: Record<PolicyName, Policy> = { idle, mover, aimer, dasher };

/** The fill bot's reaction to a new target, ticks (drawn per reaction): 200 to 300 ms. */
export const FILL_REACT_MIN_TICKS = 4;
export const FILL_REACT_MAX_TICKS = 6;
/** An aim jump past this is a new target, radians. */
export const FILL_RETARGET = 0.6;
/** How fast the fill bot's aim turns, radians a second. */
export const FILL_TURN_RATE = 8;
/** The most its aim wobbles off the aimer's, radians. */
export const FILL_WOBBLE = 0.08;
/** How far the wobble may drift in one tick, radians (a smoothed random walk). */
export const FILL_WOBBLE_STEP = 0.03;
/** It fires only while its aim is within this of the aimer's, radians. */
export const FILL_FIRE_CONE = 0.2;
/** It walks to a downed player within this, units. */
export const FILL_REVIVE_SEEK = 400;
/** It stands still this close to a downed player, inside REVIVE_RANGE, units. */
export const FILL_REVIVE_STAND = REVIVE_RANGE * 0.6;

/** The aimer's memory plus the fill bot's human layer. */
export type FillMemory = PolicyMemory & {
  /** Ticks left of a reaction (last move kept, fire held off). */
  react: number;
  /** The aimer's aim last tick, to spot a new target. */
  wanted: number;
  /** Whether it was evading last tick. */
  evading: boolean;
  /** The aim it applies (turning toward the aimer's plus the wobble). */
  applied: number;
  wobble: number;
  /** The move it applied last tick. */
  mx: number;
  my: number;
};

export function createFillMemory(): FillMemory {
  return { ...createMemory(), react: 0, wanted: 0, evading: false, applied: 0, wobble: 0, mx: 0, my: 0 };
}

export function fillBot(obs: Observation, mem: FillMemory, rng: Rng, out: PolicyInput): void {
  aimerBase(obs, mem, rng, out);
  if (!obs.self.alive) {
    mem.react = 0;
    mem.evading = false;
    return;
  }
  const { x, y } = obs.self;
  const n = nearestBug(obs);
  const near = n >= 0 ? obs.bugs[n]! : null;
  const evading = near !== null && Math.hypot(near.x - x, near.y - y) < KEEP_DIST;

  // Reaction: a new target, or a bug coming close, is acted on a moment late.
  const wanted = out.aim;
  const retarget = Math.abs(wrapAngle(wanted - mem.wanted)) > FILL_RETARGET || (evading && !mem.evading);
  mem.wanted = wanted;
  mem.evading = evading;
  if (retarget && mem.react === 0) {
    mem.react = FILL_REACT_MIN_TICKS + Math.floor(nextRandom(rng) * (FILL_REACT_MAX_TICKS - FILL_REACT_MIN_TICKS + 1));
  }

  // Aim: turn toward the aimer's aim plus the wobble, at most FILL_TURN_RATE.
  mem.wobble = Math.max(-FILL_WOBBLE, Math.min(FILL_WOBBLE, mem.wobble * 0.9 + (nextRandom(rng) - 0.5) * FILL_WOBBLE_STEP));
  const turn = wrapAngle(wanted + mem.wobble - mem.applied);
  const most = FILL_TURN_RATE * DT;
  mem.applied = wrapAngle(mem.applied + Math.max(-most, Math.min(most, turn)));
  out.aim = mem.applied;

  if (mem.react > 0) {
    mem.react--;
    out.mx = mem.mx;
    out.my = mem.my;
    out.fire = false;
  } else if (out.fire && Math.abs(wrapAngle(mem.applied - wanted)) > FILL_FIRE_CONE) out.fire = false;

  // Revive: walk to the nearest downed player in reach, swarm or not, and stand still within
  // FILL_REVIVE_STAND of them, bugs or not (the aimer would run off), so it stays inside
  // REVIVE_RANGE until the revive completes.
  if (obs.downCount > 0) {
    let best = -1;
    let bestD = FILL_REVIVE_SEEK * FILL_REVIVE_SEEK;
    for (let i = 0; i < obs.downCount; i++) {
      const d = obs.downs[i]!;
      const d2 = (d.x - x) ** 2 + (d.y - y) ** 2;
      if (d2 <= bestD) {
        bestD = d2;
        best = i;
      }
    }
    if (best >= 0) {
      const d = obs.downs[best]!;
      if (bestD > FILL_REVIVE_STAND * FILL_REVIVE_STAND) moveAlong(out, d.x - x, d.y - y, 1);
      else {
        out.mx = 0;
        out.my = 0;
      }
    }
  }
  mem.mx = out.mx;
  mem.my = out.my;
}
