// The arena simulation (release 2): pure and deterministic. The server steps it as the authority;
// the browser runs `stepMover` to predict its own robot. No clock, no Math.random, no DOM: time
// comes in as the fixed step and randomness from the arena's seeded generator. This file holds
// the state, players and lives, and the step's order; shots, heat and the streak live in
// combat.ts, bugs (spawning, the mix of kinds, contact) in bugs/ with one file per kind, pickups
// (drops, the floor, effects) in pickups/ with one file per pickup, down, revive and bleed-out in downs.ts.
import type { Team } from "../../server/rules";
import { stepBugs } from "./bugs";
import { stepFire, stepShots } from "./combat";
import { stepDrone } from "./pickups/drone";
import { stepDowns } from "./downs";
import { stepPickups } from "./pickups";
import { FIRST_LIFE_SHIELD_TICKS, SHIELD, shieldBlocks } from "./pickups/shield";
import {
  ACCEL,
  DASH_COOLDOWN_TICKS,
  DASH_SPAWN_LOCK_TICKS,
  DASH_SPEED,
  DASH_TICKS,
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
  PICKUP_IDS,
  type BugKind,
  type PickupId,
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
  /**
   * Dash pressed. Edge-triggered: a dash starts on a tick whose input has it after one that did
   * not, so holding it dashes once. While out, it respawns you (held is enough).
   */
  dash: boolean;
};

/**
 * What the movement step reads and writes: a player, or the browser's prediction of one. The dash
 * state lives here so the server and the predictor step it the same way (stepMover).
 */
export type Mover = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Dash ticks left, this one included; above 0 means dashing (and untouchable). */
  dashTicks: number;
  /** Ticks until a dash press is accepted. */
  dashCooldown: number;
  /** Last tick's `input.dash`, for the edge. */
  dashWas: boolean;
};

export type Player = Mover & {
  /** Entity id, unique within its arena. */
  id: number;
  name: string;
  team: Team;
  aim: number;
  /** The input applied each tick until a newer one arrives. */
  input: Input;
  /** Ticks since the last new input (the server zeroes a stale move). */
  idleTicks: number;
  /** In a life (false: out, waiting for a respawn press). Still true while down. */
  alive: boolean;
  /** Down (#59): in a life, but unable to move or fire until revived or bled out. */
  down: boolean;
  /** The tick of the step this player went down in (meaningful while down). */
  downTick: number;
  /** The player holding revive progress on this one (0: none). */
  reviver: number;
  /** Steps that holder has stayed in range. */
  reviveTicks: number;
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
  /** Seconds until the CI drone's next shot (#84, pickups/drone.ts); 0 without the drone. */
  droneCooldown: number;
  /** Ticks left untouchable after a hit. */
  invulnTicks: number;
  /** Ticks left of spawn protection (bugs cannot hurt you); holding fire ends it. */
  protectTicks: number;
  /** In the first life of this session (a join): its pressure starts FIRST_LIFE_EASY_S late. */
  firstLife: boolean;
  /** Bugs this player's pressure owes the arena (fractional). */
  budget: number;
  /**
   * Ticks left of each pickup's effect, by its index in PICKUP_IDS (0: not active). Allocated once
   * at the join, never replaced; a new life, the life ending and going down clear it (#73).
   */
  effect: number[];
  /** A server fill bot (#66): a hive queen's toughness counts it as half a person, and it takes no reward (#85). */
  bot: boolean;
  /**
   * Damage this life has dealt the hive queen now in the arena (#85, queen.ts): zeroed by a new
   * life and by her arrival, so only the life that dealt it is paid.
   */
  queenDmg: number;
};

/**
 * One bug, of any kind. Flat, with no per-kind objects: the phase fields mean what the kind's
 * step (bugs/<kind>.ts) makes them mean, and every spawn starts them at 0.
 */
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
  /** Its phase: an index into its kind's `phases` (0: the first). */
  phase: number;
  /** Ticks spent in this phase. */
  phaseTicks: number;
  /** A locked unit direction (for example a dasher's lunge line), when its phase has one. */
  dx: number;
  dy: number;
  /** Units left in a committed move. */
  travel: number;
  /** A goal point another part of the arena gives it (#85: a hive queen drifts toward the largest group). */
  gx: number;
  gy: number;
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
  /** Bugs it may still hit: 1 for a normal shot, LASER_PIERCE for a review laser shot (#73). */
  pierce: number;
  /** Fired under the review laser (drawn as a beam). */
  laser: boolean;
  /** Fired by a CI drone (#84): scores x1 and never touches its owner's streak; drawn violet. */
  drone: boolean;
  /** Ids of the bugs it already hit (0: none), so a piercing shot never hits one bug twice. */
  hitA: number;
  hitB: number;
  /** Bugs it has hit. */
  hits: number;
};

/** A pickup lying on the floor (#73): `id` unique within its arena, `ticksLeft` before it goes. */
export type FloorPickup = { id: number; kind: PickupId; x: number; y: number; ticksLeft: number };
/** Player `player` took a pickup of `kind` this tick. */
export type PickupTaken = { player: number; kind: PickupId };

/**
 * A shot fired this tick: where it left the barrel (a drone's shot: the drone), its angle (spread
 * included), and whether it is a review laser shot or a CI drone's (#84).
 */
export type ShotFired = { id: number; owner: number; x: number; y: number; angle: number; laser: boolean; drone: boolean };
/**
 * A shot that ended this tick: on a bug (`hit`) or at its range or a wall (not `hit`; a review
 * laser shot may have hit bugs on the way), `travelled` units from the barrel. `blocked` (#80): it
 * ended on a bug's shell (`hit` too), doing no damage.
 */
export type ShotEnded = { id: number; hit: boolean; blocked: boolean; travelled: number };
/** A bug of `kind` killed this tick, at (x, y). `by` is the shot's owner, 0 if that life is over (no points). */
export type Kill = { bug: number; by: number; x: number; y: number; points: number; kind: BugKind };
/** A bug of `kind` touched `player` this tick, costing them a hit. */
export type Touch = { player: number; kind: BugKind };
/** A finished life, as the server saves it. */
export type LifeEnd = { id: number; score: number; kills: number; ticks: number };
/** A revive this tick: player `id` brought back by `by`, who scored `points`. */
export type Revive = { id: number; by: number; points: number };
/**
 * A hive queen killed this tick (#85, queen.ts payQueen): `top` dealt her the most damage of the
 * players still in a life (0: none), and `paid` is each rewarded player's id and points.
 */
export type QueenDown = { top: number; paid: [id: number, points: number][] };

/**
 * The arena's hive queen (#85, queen.ts): stage 0 none, 1 arriving (her marker shows for
 * `ticksLeft` more ticks at x, y), 2 alive as bug `bugId` with `maxHp` hit points to start.
 */
export type QueenState = { stage: 0 | 1 | 2; x: number; y: number; ticksLeft: number; bugId: number; maxHp: number };

/** What happened in the last stepArena. The arrays are reused: cleared at the start of each step. */
export type ArenaEvents = {
  shotsFired: ShotFired[];
  shotsEnded: ShotEnded[];
  kills: Kill[];
  /** Ids of players who took a hit. */
  hitsTaken: number[];
  /** Which bug kind touched whom (each one also in hitsTaken). */
  touches: Touch[];
  livesEnded: LifeEnd[];
  /** Ids of players who went down. */
  downs: number[];
  revives: Revive[];
  /** Pickups taken (#73). */
  pickups: PickupTaken[];
  /** Ids of players whose shield blocked a hit (not in hitsTaken or touches). */
  blocks: number[];
  /** The owner of each bug hit by a review laser shot (for `bun run skill`; not sent). */
  laserHits: number[];
  /** The owner of each shot a bug's shell blocked (#80; for `bun run skill`; sent as the shot end's hit 2). */
  shellBlocks: number[];
  /** The taker of each bug a refactor bomb killed (#78; for `bun run skill`; not sent: the kill is in `kills`). */
  bombKills: number[];
  /** The owner of each bug a CI drone's shot killed (#84; for `bun run skill`; not sent: the kill is in `kills`). */
  droneKills: number[];
  /** A hive queen killed this step and who was paid (#85), else null. */
  queenDown: QueenDown | null;
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
  /** Pickups on the floor (#73), at most MAX_PICKUPS_PER_ARENA. */
  floor: FloorPickup[];
  nextPickupId: number;
  /** Pickup drops draw from here, never from `rng`, so spawns and spread replay as with no pickups. */
  dropRng: Rng;
  /** The hive queen (#85). */
  queen: QueenState;
  /** Her arrival spot draws from here, never from `rng`, so spawns and spread replay as with no queen. */
  queenRng: Rng;
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
    floor: [],
    nextPickupId: 1,
    // Not seed ^ 0x5bd1e995: skill-lib seeds the policies' own generators with that.
    dropRng: createRng(seed ^ 0x68e31da4),
    queen: { stage: 0, x: 0, y: 0, ticksLeft: 0, bugId: 0, maxHp: 0 },
    queenRng: createRng(seed ^ 0x2c1b3c6d),
    events: { shotsFired: [], shotsEnded: [], kills: [], hitsTaken: [], touches: [], livesEnded: [], downs: [], revives: [], pickups: [], blocks: [], laserHits: [], shellBlocks: [], bombKills: [], droneKills: [], queenDown: null },
  };
}

/** The arena's wave number (1 up), every WAVE_S seconds. Shown only: it never changes spawn volume. */
export function wave(tick: number): number {
  return 1 + Math.floor((tick * DT) / WAVE_S);
}

/**
 * Starts a fresh life for `p` at (x, y): every life field reset, with SPAWN_PROTECT_S of spawn
 * protection, and on a first life in a session the test shield up (#90, FIRST_LIFE_SHIELD_S).
 */
function startLife(state: ArenaState, p: Player, x: number, y: number): void {
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.alive = true;
  clearDown(p);
  p.hits = 0;
  p.lifeStartTick = state.tick;
  p.score = 0;
  p.kills = 0;
  p.streak = 0;
  p.heat = 0;
  p.lockTicks = 0;
  p.fireCooldown = 0;
  p.droneCooldown = 0;
  p.invulnTicks = 0;
  p.protectTicks = Math.round(SPAWN_PROTECT_S / DT);
  p.budget = 0;
  p.dashTicks = 0;
  p.dashCooldown = DASH_SPAWN_LOCK_TICKS;
  p.effect.fill(0);
  if (p.firstLife) p.effect[SHIELD] = FIRST_LIFE_SHIELD_TICKS;
  p.queenDmg = 0;
}

function clearDown(p: Player): void {
  p.down = false;
  p.downTick = 0;
  p.reviver = 0;
  p.reviveTicks = 0;
}

/** In a life and not down: can move, fire, be chased and revive others. */
export function canAct(p: Player): boolean {
  return p.alive && !p.down;
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

/** Adds a player, in a new life at a safe random spot. `bot`: a server fill bot (#66, #85). */
export function joinPlayer(state: ArenaState, name: string, team: Team, bot = false): Player {
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
    down: false,
    downTick: 0,
    reviver: 0,
    reviveTicks: 0,
    hits: 0,
    lifeStartTick: 0,
    outTick: 0,
    score: 0,
    kills: 0,
    streak: 0,
    heat: 0,
    lockTicks: 0,
    fireCooldown: 0,
    droneCooldown: 0,
    invulnTicks: 0,
    protectTicks: 0,
    firstLife: true,
    budget: 0,
    dashTicks: 0,
    dashCooldown: 0,
    dashWas: false,
    effect: PICKUP_IDS.map(() => 0),
    bot,
    queenDmg: 0,
  };
  startLife(state, p, spot.x, spot.y);
  state.players.push(p);
  return p;
}

/** Ends `p`'s life now (from up or down) and returns its record. */
export function endLife(state: ArenaState, p: Player): LifeEnd {
  p.alive = false;
  clearDown(p);
  p.outTick = state.tick;
  p.vx = 0;
  p.vy = 0;
  p.dashTicks = 0;
  p.effect.fill(0);
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

/**
 * Whether a bug touching `p` costs it a hit: up (in a life and not down), past any hit or spawn
 * protection, and not dashing.
 */
export function canBeHit(p: Player): boolean {
  return canAct(p) && p.invulnTicks === 0 && p.protectTicks === 0 && p.dashTicks === 0;
}

/**
 * Every hit on a player enters here (bugs/index.ts contact today; a later hit source, such as a
 * spitter's spit, must call this too, never hitPlayer). The caller checked `p` can be hit and
 * spends whatever hit it. A test shield (#73, pickups/shield.ts) blocks the hit: the shield is
 * spent, `p` is untouchable for INVULN_S as after a hit (so a second bug in the same contact pass
 * does not land at once), and events.blocks gets `p` (no touch, no hit taken). Else `p` takes it:
 * events.touches gets which kind, and hitPlayer.
 */
export function strikePlayer(state: ArenaState, p: Player, kind: BugKind): void {
  if (shieldBlocks(p)) {
    p.invulnTicks = Math.round(INVULN_S / DT);
    state.events.blocks.push(p.id);
    return;
  }
  state.events.touches.push({ player: p.id, kind });
  hitPlayer(state, p);
}

/**
 * Takes a hit on `p` (the caller checked it can be hit): untouchable for a moment; the last hit
 * puts it down (downs.ts revives it or bleeds it out). Only strikePlayer calls it, after a shield.
 */
export function hitPlayer(state: ArenaState, p: Player): void {
  p.hits++;
  p.invulnTicks = Math.round(INVULN_S / DT);
  state.events.hitsTaken.push(p.id);
  if (p.hits >= HITS_PER_LIFE) downPlayer(state, p);
}

/** Puts `p` down: it stops where it is, and nothing protects it (bugs ignore it anyway). */
function downPlayer(state: ArenaState, p: Player): void {
  p.down = true;
  p.downTick = state.tick;
  p.reviver = 0;
  p.reviveTicks = 0;
  p.vx = 0;
  p.vy = 0;
  p.invulnTicks = 0;
  p.dashTicks = 0;
  p.effect.fill(0);
  state.events.downs.push(p.id);
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
  moveAndWall(p, dt);
}

/** Moves by the velocity, then the walls hold the player inside and stop the velocity pushing into them. */
function moveAndWall(p: { x: number; y: number; vx: number; vy: number }, dt: number): void {
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

/**
 * THE step of a robot in a life, dash included: used by the server (stepArena) and by the
 * browser's prediction, so both move you the same way. `input` must be clamped (clampInput).
 * - The dash and its cooldown count down a tick.
 * - A dash press (input.dash after a tick without it), with the cooldown run out and no dash
 *   going, starts a dash: DASH_SPEED along the move direction (a half-pushed stick dashes as
 *   far), or along the aim when no move is held, for DASH_TICKS ticks, this one included. A press
 *   too early is dropped, not kept for later.
 * - While dashing the move input is ignored: the robot flies on, and the walls stop the part of
 *   the velocity pushing into them (a slanted dash slides along a wall).
 * - On the tick after a dash, the speed is cut to MAX_SPEED before the normal step, so a dash
 *   carries DASH_DISTANCE and does not slide on.
 * - Otherwise it is exactly stepPlayer.
 * Draws no randomness.
 */
export function stepMover(m: Mover, input: Input): void {
  const wasDashing = m.dashTicks > 0;
  if (m.dashTicks > 0) m.dashTicks--;
  if (m.dashCooldown > 0) m.dashCooldown--;
  const pressed = input.dash && !m.dashWas;
  m.dashWas = input.dash;
  if (pressed && m.dashCooldown === 0 && m.dashTicks === 0) {
    let dx = input.mx;
    let dy = input.my;
    const len = Math.hypot(dx, dy);
    if (len > 0) {
      dx /= len;
      dy /= len;
    } else {
      dx = Math.cos(input.aim);
      dy = Math.sin(input.aim);
    }
    m.vx = dx * DASH_SPEED;
    m.vy = dy * DASH_SPEED;
    m.dashTicks = DASH_TICKS;
    m.dashCooldown = DASH_COOLDOWN_TICKS;
  }
  if (m.dashTicks > 0) {
    moveAndWall(m, DT);
    return;
  }
  if (wasDashing) {
    const speed = Math.hypot(m.vx, m.vy);
    if (speed > MAX_SPEED) {
      m.vx *= MAX_SPEED / speed;
      m.vy *= MAX_SPEED / speed;
    }
  }
  stepPlayer(m, input.mx, input.my, DT);
}

const RESPAWN_DELAY_TICKS = Math.round(RESPAWN_DELAY_S / DT);

/**
 * Advances the arena one fixed step, in a fixed order (arrays in index order, every random draw
 * from state.rng, pickup drops from state.dropRng), so the same seed and inputs replay exactly:
 * 1. players: those up move and dash (stepMover); a downed player stands still, its aim frozen
 *    and its dash ignored; an out player whose input has dash, RESPAWN_DELAY_S or more after
 *    going out, respawns at a safeSpot in a life that is no longer their first; a player who is
 *    up and holding fire loses any spawn protection left, before they fire;
 * 2. fire and heat, then a CI drone's shots, players who are up only (combat.ts, pickups/drone.ts);
 * 3. bugs: personal spawn budgets, spawning out of view, each kind's step, contact hits (a test
 *    shield blocks one: strikePlayer); the last hit puts a player down (bugs/);
 * 4. shots: travel, hits (a review laser shot pierces), kills, misses (combat.ts);
 * 5. pickups: effects count down, floor pickups age, this step's kills drop, players who are up
 *    take what they touch (a refactor bomb goes off at the take, its kills drop too and its dead
 *    bugs leave in the same step) (pickups/);
 * 6. downs: revive progress, revives and bleed-outs (downs.ts);
 * 7. spawn protection counts down (after contact, so a join and a respawn are both protected for
 *    SPAWN_PROTECT_S of contact steps), and the tick counts.
 * `state.events` reports what happened in this step.
 */
export function stepArena(state: ArenaState): void {
  const ev = state.events;
  ev.shotsFired.length = 0;
  ev.shotsEnded.length = 0;
  ev.kills.length = 0;
  ev.hitsTaken.length = 0;
  ev.touches.length = 0;
  ev.livesEnded.length = 0;
  ev.downs.length = 0;
  ev.revives.length = 0;
  ev.pickups.length = 0;
  ev.blocks.length = 0;
  ev.laserHits.length = 0;
  ev.shellBlocks.length = 0;
  ev.bombKills.length = 0;
  ev.droneKills.length = 0;
  ev.queenDown = null;
  for (const p of state.players) {
    if (!p.alive) {
      p.aim = p.input.aim;
      if (p.input.dash && state.tick - p.outTick >= RESPAWN_DELAY_TICKS) {
        safeSpot(state, p.id);
        p.firstLife = false;
        startLife(state, p, spot.x, spot.y);
      }
      // The edge is tracked while out too, so the press that respawned you is not also a dash.
      p.dashWas = p.input.dash;
    } else if (p.down) {
      // Tracked while down too, so a dash held through the revive is not a press on the way up.
      p.dashWas = p.input.dash;
    } else {
      p.aim = p.input.aim;
      stepMover(p, p.input);
      if (p.invulnTicks > 0) p.invulnTicks--;
    }
    if (canAct(p) && p.input.fire) p.protectTicks = 0;
  }
  for (const p of state.players) {
    if (!canAct(p)) continue;
    stepFire(state, p);
    stepDrone(state, p);
  }
  stepBugs(state);
  stepShots(state);
  stepPickups(state);
  stepDowns(state);
  for (const p of state.players) if (p.alive && p.protectTicks > 0) p.protectTicks--;
  state.tick++;
}
