// The arena simulation (release 2): pure and deterministic. The server steps it as the authority;
// the browser runs `stepPlayer` to predict its own robot. No clock, no Math.random, no DOM: time
// comes in as the fixed step and randomness from the arena's seeded generator. This file holds
// the state, players and lives, and the step's order; shots, heat and the streak live in
// combat.ts, crawlers and spawning in bugs.ts.
import type { Team } from "../../server/rules";
import { stepBugs } from "./bugs";
import { stepFire, stepShots } from "./combat";
import {
  ACCEL,
  DT,
  FRICTION,
  HITS_PER_LIFE,
  INVULN_S,
  MAX_SPEED,
  PLAYER_RADIUS,
  RESPAWN_DELAY_S,
  SPAWN_BUG_CLEAR,
  SPAWN_BUG_FLOOR,
  SPAWN_CANDIDATES,
  SPAWN_GRID_STEP,
  SPAWN_MARGIN,
  SPAWN_NEAR_DIST,
  SPAWN_PROTECT_S,
  WAVE_S,
  WORLD_H,
  WORLD_W,
  type BugKind,
} from "./constants";
import { createRng, nextRandom, type Rng } from "./rng";

/** One player's input for one tick. */
export type Input = {
  /** Sequence number, rising by one per input; the server echoes the last one it applied. */
  seq: number;
  /** Move vector, clamped to length 1. */
  mx: number;
  my: number;
  /** Aim angle, radians, in (-pi, pi]. */
  aim: number;
  /** Fire held. */
  fire: boolean;
  /** Dash pressed (one press). While out, it respawns you; the dash itself comes with a later item. */
  dash: boolean;
};

export type Player = {
  /** Entity id, unique within its arena. */
  id: number;
  name: string;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  /** The input applied each tick until a newer one arrives. */
  input: Input;
  /** Ticks since the last new input (the server zeroes a stale move). */
  idleTicks: number;
  /** In a life (false: out, waiting for a respawn press). */
  alive: boolean;
  /** Hits taken this life. */
  hits: number;
  /** The tick this life began. */
  lifeStartTick: number;
  /** The tick this player went out (meaningful while !alive). */
  outTick: number;
  /** This life's score, kills and hit streak. */
  score: number;
  kills: number;
  streak: number;
  /** Gun heat, 0 to 1. */
  heat: number;
  /** Ticks the gun stays locked after overheating. */
  lockTicks: number;
  /** Seconds until the next shot may leave (negative: owed this tick). */
  fireCooldown: number;
  /** Ticks left untouchable after a hit. */
  invulnTicks: number;
  /** Ticks left of spawn protection (bugs cannot hurt you); holding fire ends it. */
  protectTicks: number;
  /** In the first life of this session (a join): its pressure starts FIRST_LIFE_EASY_S late. */
  firstLife: boolean;
  /** Bugs this player's pressure owes the arena (fractional). */
  budget: number;
};

export type Bug = {
  id: number;
  kind: BugKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  /** The player it chases this tick (0: none). */
  target: number;
};

export type Shot = {
  id: number;
  /** The player who fired it. */
  owner: number;
  /** The owner's lifeStartTick when fired: only that life is credited (a later life is not). */
  life: number;
  x: number;
  y: number;
  /** Unit direction. */
  dx: number;
  dy: number;
  /** Units flown so far. */
  travelled: number;
};

/** A shot fired this tick: where it left the barrel and its angle (spread included). */
export type ShotFired = { id: number; owner: number; x: number; y: number; angle: number };
/** A shot that ended this tick: on a bug (a hit) or at its range or a wall (a miss), `travelled` units from the barrel. */
export type ShotEnded = { id: number; hit: boolean; travelled: number };
/** A bug killed this tick, at (x, y). `by` is the shot's owner, 0 if that life is over (no points). */
export type Kill = { bug: number; by: number; x: number; y: number; points: number };
/** A finished life, as the server saves it. */
export type LifeEnd = { id: number; score: number; kills: number; ticks: number };

/** What happened in the last stepArena. The arrays are reused: cleared at the start of each step. */
export type ArenaEvents = {
  shotsFired: ShotFired[];
  shotsEnded: ShotEnded[];
  kills: Kill[];
  /** Ids of players who took a hit. */
  hitsTaken: number[];
  livesEnded: LifeEnd[];
};

export type ArenaState = {
  tick: number;
  rng: Rng;
  players: Player[];
  nextId: number;
  bugs: Bug[];
  shots: Shot[];
  nextBugId: number;
  nextShotId: number;
  events: ArenaEvents;
};

export function noInput(seq = 0): Input {
  return { seq, mx: 0, my: 0, aim: 0, fire: false, dash: false };
}

export function createArena(seed: number): ArenaState {
  return {
    tick: 0,
    rng: createRng(seed),
    players: [],
    nextId: 1,
    bugs: [],
    shots: [],
    nextBugId: 1,
    nextShotId: 1,
    events: { shotsFired: [], shotsEnded: [], kills: [], hitsTaken: [], livesEnded: [] },
  };
}

/** The arena's wave number (1 up), every WAVE_S seconds. Shown only: it never changes spawn volume. */
export function wave(tick: number): number {
  return 1 + Math.floor((tick * DT) / WAVE_S);
}

/** Starts a fresh life for `p` at (x, y): every life field reset, with SPAWN_PROTECT_S of spawn protection. */
function startLife(state: ArenaState, p: Player, x: number, y: number): void {
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.alive = true;
  p.hits = 0;
  p.lifeStartTick = state.tick;
  p.score = 0;
  p.kills = 0;
  p.streak = 0;
  p.heat = 0;
  p.lockTicks = 0;
  p.fireCooldown = 0;
  p.invulnTicks = 0;
  p.protectTicks = Math.round(SPAWN_PROTECT_S / DT);
  p.budget = 0;
}

/** Whether a bug touching `p` costs a hit: alive, and neither just hit nor spawn-protected. */
export function canBeHit(p: Player): boolean {
  return p.alive && p.invulnTicks === 0 && p.protectTicks === 0;
}

const spot = { x: 0, y: 0 };

/** The squared distance from (x, y) to the nearest bug (Infinity with none). */
function nearestBugD2(state: ArenaState, x: number, y: number): number {
  let best = Infinity;
  for (const b of state.bugs) {
    const dx = b.x - x;
    const dy = b.y - y;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return best;
}

/** The distance from (x, y) to the nearest alive player other than `selfId` (Infinity with none). */
function nearestOtherD(state: ArenaState, selfId: number, x: number, y: number): number {
  let best = Infinity;
  for (const q of state.players) {
    if (!q.alive || q.id === selfId) continue;
    const d = Math.hypot(q.x - x, q.y - y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Picks a spawn spot for player `selfId` and returns it (the module's one reused object).
 * SPAWN_CANDIDATES spots are drawn, all of them every time so the generator's use is fixed,
 * uniformly at least SPAWN_MARGIN from every wall. Among those at least SPAWN_BUG_CLEAR from every
 * bug it takes the one whose nearest other alive player is closest to SPAWN_NEAR_DIST away (help
 * nearby, not on top of them), or the first when no one else is alive. When none is clear, the one
 * farthest from any bug; and when even that is under SPAWN_BUG_FLOOR, a grid of spots SPAWN_GRID_STEP
 * apart over the same square is searched for the one farthest from any bug, so the floor holds
 * whenever the grid has a spot that meets it. Ties go to the earlier spot.
 */
function safeSpot(state: ArenaState, selfId: number): { x: number; y: number } {
  const clear2 = SPAWN_BUG_CLEAR * SPAWN_BUG_CLEAR;
  let haveClear = false;
  let bestScore = Infinity; // |nearest other player - SPAWN_NEAR_DIST| of the best clear spot
  let farthest = -1; // the fallback's nearest-bug distance, squared
  let fx = 0;
  let fy = 0;
  for (let i = 0; i < SPAWN_CANDIDATES; i++) {
    const x = SPAWN_MARGIN + nextRandom(state.rng) * (WORLD_W - 2 * SPAWN_MARGIN);
    const y = SPAWN_MARGIN + nextRandom(state.rng) * (WORLD_H - 2 * SPAWN_MARGIN);
    const dBug2 = nearestBugD2(state, x, y);
    if (dBug2 >= clear2) {
      const dp = nearestOtherD(state, selfId, x, y);
      const score = dp === Infinity ? 0 : Math.abs(dp - SPAWN_NEAR_DIST);
      if (!haveClear || score < bestScore) {
        haveClear = true;
        bestScore = score;
        spot.x = x;
        spot.y = y;
      }
    } else if (!haveClear && dBug2 > farthest) {
      farthest = dBug2;
      fx = x;
      fy = y;
    }
  }
  if (!haveClear) {
    if (farthest < SPAWN_BUG_FLOOR * SPAWN_BUG_FLOOR) {
      // Rare (a crowded arena): a deterministic search, so the generator's use stays fixed.
      for (let x = SPAWN_MARGIN; x <= WORLD_W - SPAWN_MARGIN; x += SPAWN_GRID_STEP) {
        for (let y = SPAWN_MARGIN; y <= WORLD_H - SPAWN_MARGIN; y += SPAWN_GRID_STEP) {
          const d = nearestBugD2(state, x, y);
          if (d > farthest) {
            farthest = d;
            fx = x;
            fy = y;
          }
        }
      }
    }
    spot.x = fx;
    spot.y = fy;
  }
  return spot;
}

/** Adds a player, in a new life at a safe random spot. */
export function joinPlayer(state: ArenaState, name: string, team: Team): Player {
  const id = state.nextId++;
  safeSpot(state, id);
  const p: Player = {
    id,
    name,
    team,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    aim: 0,
    input: noInput(),
    idleTicks: 0,
    alive: true,
    hits: 0,
    lifeStartTick: 0,
    outTick: 0,
    score: 0,
    kills: 0,
    streak: 0,
    heat: 0,
    lockTicks: 0,
    fireCooldown: 0,
    invulnTicks: 0,
    protectTicks: 0,
    firstLife: true,
    budget: 0,
  };
  startLife(state, p, spot.x, spot.y);
  state.players.push(p);
  return p;
}

/** Ends `p`'s life now and returns its record. */
function endLife(state: ArenaState, p: Player): LifeEnd {
  p.alive = false;
  p.outTick = state.tick;
  p.vx = 0;
  p.vy = 0;
  return { id: p.id, score: p.score, kills: p.kills, ticks: state.tick - p.lifeStartTick };
}

/**
 * Removes a player. Null if there was none with that id; else `life` is the life the leave ended
 * (null if the player was already out), for the server to save. It is returned rather than put
 * in `events.livesEnded`, because a leave happens between ticks and that list belongs to the
 * last step.
 */
export function leavePlayer(state: ArenaState, id: number): { life: LifeEnd | null } | null {
  const i = state.players.findIndex((p) => p.id === id);
  if (i < 0) return null;
  const p = state.players[i]!;
  const life = p.alive ? endLife(state, p) : null;
  state.players.splice(i, 1);
  return { life };
}

/** Takes a hit on `p` (the caller checked canBeHit): untouchable for INVULN_S; the last hit ends the life. */
export function hitPlayer(state: ArenaState, p: Player): void {
  p.hits++;
  p.invulnTicks = Math.round(INVULN_S / DT);
  state.events.hitsTaken.push(p.id);
  if (p.hits >= HITS_PER_LIFE) state.events.livesEnded.push(endLife(state, p));
}

/** Wraps an angle to (-pi, pi]. */
export function wrapAngle(a: number): number {
  if (a > -Math.PI && a <= Math.PI) return a;
  const t = a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
  return t === -Math.PI ? Math.PI : t;
}

/**
 * Makes an input safe to step, in place: a non-finite move or aim becomes 0, a move longer than
 * 1 is scaled to length 1, and the aim is wrapped to (-pi, pi]. Returns the same object.
 */
export function clampInput(input: Input): Input {
  if (!Number.isFinite(input.mx)) input.mx = 0;
  if (!Number.isFinite(input.my)) input.my = 0;
  if (!Number.isFinite(input.aim)) input.aim = 0;
  const len = Math.hypot(input.mx, input.my);
  if (len > 1) {
    input.mx /= len;
    input.my /= len;
  }
  input.aim = wrapAngle(input.aim);
  input.fire = input.fire === true;
  input.dash = input.dash === true;
  return input;
}

/** Moves `v` toward `target` by at most `step` (a vector step), writing into `out`. */
function approach(vx: number, vy: number, tx: number, ty: number, step: number, out: { x: number; y: number }): void {
  const dx = tx - vx;
  const dy = ty - vy;
  const d = Math.hypot(dx, dy);
  if (d <= step) {
    out.x = tx;
    out.y = ty;
  } else {
    out.x = vx + (dx / d) * step;
    out.y = vy + (dy / d) * step;
  }
}

const scratch = { x: 0, y: 0 };

/**
 * THE movement step, used by the server and by the browser's prediction: velocity moves toward
 * the move vector times MAX_SPEED by at most ACCEL * dt while a move is held, else toward rest by
 * at most FRICTION * dt; then the position moves; then the walls hold the player inside and stop
 * the velocity pushing into them. `mx, my` must already be clamped (clampInput).
 */
export function stepPlayer(
  p: { x: number; y: number; vx: number; vy: number },
  mx: number,
  my: number,
  dt: number = DT,
): void {
  if (mx !== 0 || my !== 0) approach(p.vx, p.vy, mx * MAX_SPEED, my * MAX_SPEED, ACCEL * dt, scratch);
  else approach(p.vx, p.vy, 0, 0, FRICTION * dt, scratch);
  p.vx = scratch.x;
  p.vy = scratch.y;
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const R = PLAYER_RADIUS;
  if (p.x < R) {
    p.x = R;
    if (p.vx < 0) p.vx = 0;
  } else if (p.x > WORLD_W - R) {
    p.x = WORLD_W - R;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.y < R) {
    p.y = R;
    if (p.vy < 0) p.vy = 0;
  } else if (p.y > WORLD_H - R) {
    p.y = WORLD_H - R;
    if (p.vy > 0) p.vy = 0;
  }
}

const RESPAWN_DELAY_TICKS = Math.round(RESPAWN_DELAY_S / DT);

/**
 * Advances the arena one fixed step, in a fixed order (arrays in index order, every random draw
 * from state.rng), so the same seed and inputs replay exactly:
 * 1. players: the alive move; an out player whose input has dash, RESPAWN_DELAY_S or more after
 *    going out, respawns at a safeSpot in a life that is no longer their first; an alive player
 *    holding fire loses any spawn protection left, before they fire;
 * 2. fire and heat, alive players only (combat.ts);
 * 3. bugs: personal spawn budgets, spawning out of view, chasing, contact hits (bugs.ts);
 * 4. shots: travel, hits, kills, misses (combat.ts);
 * 5. spawn protection counts down (after contact, so a join and a respawn are both protected for
 *    SPAWN_PROTECT_S of contact steps), and the tick counts.
 * `state.events` reports what happened in this step.
 */
export function stepArena(state: ArenaState): void {
  const ev = state.events;
  ev.shotsFired.length = 0;
  ev.shotsEnded.length = 0;
  ev.kills.length = 0;
  ev.hitsTaken.length = 0;
  ev.livesEnded.length = 0;
  for (const p of state.players) {
    p.aim = p.input.aim;
    if (p.alive) {
      stepPlayer(p, p.input.mx, p.input.my);
      if (p.invulnTicks > 0) p.invulnTicks--;
    } else if (p.input.dash && state.tick - p.outTick >= RESPAWN_DELAY_TICKS) {
      safeSpot(state, p.id);
      p.firstLife = false;
      startLife(state, p, spot.x, spot.y);
    }
    if (p.alive && p.input.fire) p.protectTicks = 0;
  }
  for (const p of state.players) if (p.alive) stepFire(state, p);
  stepBugs(state);
  stepShots(state);
  for (const p of state.players) if (p.alive && p.protectTicks > 0) p.protectTicks--;
  state.tick++;
}
