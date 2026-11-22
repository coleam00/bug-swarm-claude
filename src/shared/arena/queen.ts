// The hive queen's arena rules (#85): when and where she arrives, how tough she is, where she
// drifts, who damaged her and what her kill pays. How she moves and what she launches is her kind
// file, bugs/queen.ts, on the bug-kind seam like any other kind. Pure and deterministic: her spot
// draws from state.queenRng, never state.rng, so spawns and spread replay as they would without her.
// - Arrival (stepQueen): on the first tick of every QUEEN_EVERY_WAVES-th wave, unless a queen is
//   already arriving or alive (at most one; she never leaves but by dying), her marker shows at a
//   spot (queenSpot) for QUEEN_MARKER_TICKS; nothing is there to hurt anyone. Then she is placed
//   there with queenHp hit points, every player's damage on her starting at 0.
// - Goal (stepQueen, every tick she lives): the middle of the largest group of players who are up
//   (groupGoal), written into her gx, gy for her step.
// - Damage (bugs/queen.ts creditQueen): every hit on her credits the player whose life dealt it, at
//   most the hit points she had left. Every damage source calls it: shots (combat.ts) and the
//   refactor bomb (pickups/bomb.ts); the CI drone's (#84) are shots. A new source that is not a
//   shot must call it too, or its damage is never paid.
// - Reward (payQueen, after pickups, the step she dies): every person (not a fill bot) still in the
//   life that damaged her, up or down, gets QUEEN_REWARD_EACH plus a share of QUEEN_REWARD_POOL by
//   damage dealt, rounded down (queenRewards), on their life's score. A life that ended before the
//   kill gets nothing: a new life starts at 0.
import { newBug } from "./bugs/index";
import { BROOD_TICKS, QUEEN_EVERY_WAVES } from "./bugs/queen";
import { DT, WORLD_H, WORLD_W } from "./constants";
import { nextRandom } from "./rng";
import { canAct, wave, type ArenaState, type Bug, type Player } from "./sim";

/** How long her marker shows before she arrives, ticks (2 s); she can hurt no one during it. */
export const QUEEN_MARKER_TICKS = Math.round(2 / DT);
/** Her spot is at least this far from every player in a life, units, when such a spot exists. */
export const QUEEN_PLAYER_CLEAR = 600;
/** ...and at least this far from every wall, units: the grid her spot is chosen from. */
export const QUEEN_WALL_CLEAR = 300;
export const QUEEN_GRID_STEP = 100;
/**
 * Her hit points: a base plus this much per person in the arena when she arrives, half for a fill
 * bot. The item's 150 + 60 (390 for 4 people) took 4 scripted aimers past 180 s on every one of 30
 * seeds (on 41b96f7), as their two-minute-old lives are swarmed by their own spawns and they shoot
 * only the nearest bug; these numbers bring the median under the item's 60 s (`bun run skill`, #85).
 */
export const QUEEN_HP_BASE = 40;
export const QUEEN_HP_PERSON = 20;
export const QUEEN_HP_BOT = 10;
/** Every paid person gets this, plus a share of the pool by damage dealt. */
export const QUEEN_REWARD_EACH = 75;
export const QUEEN_REWARD_POOL = 600;
/** Players who are up within this of one another count as one group (her goal), units. */
export const GROUP_R = 300;

export { QUEEN_EVERY_WAVES };

/** Whether a queen arrives on the step of `tick`: the first tick of a QUEEN_EVERY_WAVES-th wave. */
export function queenWaveStarts(tick: number): boolean {
  if (tick <= 0) return false;
  const w = wave(tick);
  return w % QUEEN_EVERY_WAVES === 0 && w !== wave(tick - 1);
}

/** Her hit points for the players in the arena now (every one on the roster, in a life or out). */
export function queenHp(players: readonly Pick<Player, "bot">[]): number {
  let hp = QUEEN_HP_BASE;
  for (const p of players) hp += p.bot ? QUEEN_HP_BOT : QUEEN_HP_PERSON;
  return hp;
}

const GRID_N = Math.floor((WORLD_W - 2 * QUEEN_WALL_CLEAR) / QUEEN_GRID_STEP) + 1;
/** Indexes of the grid spots far enough from everyone, reused. */
const candidates = new Int32Array(GRID_N * GRID_N);

/**
 * Where she arrives, into `out`: a spot on a QUEEN_GRID_STEP grid at least QUEEN_WALL_CLEAR from
 * every wall. Among those at least QUEEN_PLAYER_CLEAR from every player in a life (downed ones
 * too), one drawn from state.queenRng (with nobody in a life, every spot qualifies). When none is
 * that clear (a crowd spread over the arena), the one farthest from its nearest player, the first
 * in grid order on a tie, with no draw. Allocates nothing.
 */
export function queenSpot(state: ArenaState, out: { x: number; y: number }): void {
  const clear2 = QUEEN_PLAYER_CLEAR * QUEEN_PLAYER_CLEAR;
  let n = 0;
  let best = -1;
  let bestD = -1;
  for (let i = 0; i < GRID_N * GRID_N; i++) {
    const x = QUEEN_WALL_CLEAR + (i % GRID_N) * QUEEN_GRID_STEP;
    const y = QUEEN_WALL_CLEAR + Math.floor(i / GRID_N) * QUEEN_GRID_STEP;
    let near = Infinity;
    for (const p of state.players) {
      if (!p.alive) continue;
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < near) near = d;
    }
    if (near >= clear2) candidates[n++] = i;
    if (near > bestD) {
      bestD = near;
      best = i;
    }
  }
  const pick = n > 0 ? candidates[Math.floor(nextRandom(state.queenRng) * n)]! : best;
  out.x = QUEEN_WALL_CLEAR + (pick % GRID_N) * QUEEN_GRID_STEP;
  out.y = QUEEN_WALL_CLEAR + Math.floor(pick / GRID_N) * QUEEN_GRID_STEP;
}

/**
 * Her goal, into `out`: for each player who is up, the players who are up within GROUP_R of them
 * (themselves included); the one with the most (ties: the nearer to her, then the earlier in the
 * list), and the mean position of that group. False with nobody up. O(n²) over at most 20 players,
 * allocating nothing.
 */
export function groupGoal(players: readonly Player[], qx: number, qy: number, out: { x: number; y: number }): boolean {
  const r2 = GROUP_R * GROUP_R;
  let best: Player | null = null;
  let bestN = 0;
  let bestD = Infinity;
  for (const p of players) {
    if (!canAct(p)) continue;
    let n = 0;
    for (const o of players) if (canAct(o) && (o.x - p.x) ** 2 + (o.y - p.y) ** 2 <= r2) n++;
    const d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
    if (n > bestN || (n === bestN && d < bestD)) {
      best = p;
      bestN = n;
      bestD = d;
    }
  }
  if (!best) return false;
  let sx = 0;
  let sy = 0;
  for (const o of players) {
    if (!canAct(o) || (o.x - best.x) ** 2 + (o.y - best.y) ** 2 > r2) continue;
    sx += o.x;
    sy += o.y;
  }
  out.x = sx / bestN;
  out.y = sy / bestN;
  return true;
}

const at = { x: 0, y: 0 };

/** Her bug, while she lives; else null. */
function queenBug(state: ArenaState): Bug | null {
  const q = state.queen;
  if (q.stage !== 2) return null;
  for (const b of state.bugs) if (b.id === q.bugId) return b;
  return null;
}

/**
 * Her arrival and her goal, one step (sim.ts stepArena, before bugs): a QUEEN_EVERY_WAVES-th wave
 * starting with no queen staged shows her marker at queenSpot; the marker counts down and at 0 she
 * is placed there (queenHp, every player's damage on her zeroed); while she lives, her goal is the
 * largest group (groupGoal), or where she stands with nobody up.
 */
export function stepQueen(state: ArenaState): void {
  const q = state.queen;
  if (q.stage === 0) {
    if (!queenWaveStarts(state.tick)) return;
    queenSpot(state, at);
    q.stage = 1;
    q.x = at.x;
    q.y = at.y;
    q.ticksLeft = QUEEN_MARKER_TICKS;
    return;
  }
  if (q.stage === 1) {
    if (--q.ticksLeft > 0) return;
    const b = newBug(state, "queen", q.x, q.y, 0);
    b.hp = q.maxHp = queenHp(state.players);
    b.dx = 1;
    b.dy = 0;
    b.travel = BROOD_TICKS;
    b.gx = q.x;
    b.gy = q.y;
    q.bugId = b.id;
    q.stage = 2;
    for (const p of state.players) p.queenDmg = 0;
  }
  const b = queenBug(state);
  if (!b) {
    // Gone without a kill row (never, today): nothing is staged any more.
    q.stage = 0;
    return;
  }
  q.x = b.x;
  q.y = b.y;
  if (groupGoal(state.players, b.x, b.y, at)) {
    b.gx = at.x;
    b.gy = at.y;
  } else {
    b.gx = b.x;
    b.gy = b.y;
  }
}

/**
 * The rewards for damage `dmg[i]` dealt by each paid player, into `out[i]`: QUEEN_REWARD_EACH plus
 * floor(QUEEN_REWARD_POOL * dmg[i] / the sum) for each above 0, else 0. Rounded down, so the shares
 * never add up past the pool. Allocates nothing.
 */
export function queenRewards(dmg: readonly number[], out: number[]): void {
  let sum = 0;
  for (const d of dmg) if (d > 0) sum += d;
  out.length = dmg.length;
  for (let i = 0; i < dmg.length; i++) {
    const d = dmg[i]!;
    out[i] = d > 0 ? QUEEN_REWARD_EACH + Math.floor((QUEEN_REWARD_POOL * d) / sum) : 0;
  }
}

/** Whether `p` is paid at her kill: a person (not a fill bot) in a life (up or down) that damaged her. */
export function paidAtKill(p: Player): boolean {
  return !p.bot && p.alive && p.queenDmg > 0;
}

const dmgs: number[] = [];
const pays: number[] = [];

/**
 * Pays her kill (sim.ts stepArena, after pickups, so a shot kill and a bomb kill are both in this
 * step's kills): every paidAtKill player gets queenRewards of their damage on their life's score,
 * events.queenDown names them and the top damage dealer (the most damage among players in a life,
 * fill bots too; ties: the earlier in the list), and nothing is staged any more.
 */
export function payQueen(state: ArenaState): void {
  const q = state.queen;
  if (q.stage !== 2) return;
  let killed = false;
  for (const k of state.events.kills) if (k.bug === q.bugId) killed = true;
  if (!killed) return;
  dmgs.length = 0;
  for (const p of state.players) if (paidAtKill(p)) dmgs.push(p.queenDmg);
  queenRewards(dmgs, pays);
  const paid: [number, number][] = [];
  let i = 0;
  let top = 0;
  let topDmg = 0;
  for (const p of state.players) {
    if (p.alive && p.queenDmg > topDmg) {
      topDmg = p.queenDmg;
      top = p.id;
    }
    if (!paidAtKill(p)) continue;
    const points = pays[i++]!;
    p.score += points;
    paid.push([p.id, points]);
  }
  state.events.queenDown = { top, paid };
  q.stage = 0;
  q.bugId = 0;
}
