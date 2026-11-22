// Bugs (#55, the kind seam #65): personal spawn pressure, spawning out of view, the mix of kinds,
// each kind's step and contact. Stepped by sim.ts stepArena. Pure and deterministic. What a kind
// is lives in its own file (kind.ts, registry.ts); this file treats every kind the same.
import {
  BUG_KINDS,
  DT,
  FIRST_LIFE_EASY_S,
  MAX_BUGS_PER_ARENA,
  PLAYER_RADIUS,
  SPAWN_BASE_PER_S,
  SPAWN_BUDGET_CAP,
  SPAWN_DIST_MAX,
  SPAWN_DIST_MIN,
  SPAWN_MAX_PER_S,
  SPAWN_RAMP_PER_S2,
  SPAWN_TRIES,
  VIEW_MAX,
  VIEW_PAD,
  VIEW_WALL_MARGIN,
  WORLD_H,
  WORLD_W,
  type BugKind,
} from "../constants";
import { nextRandom } from "../rng";
import { canAct, canBeHit, strikePlayer, wave, type ArenaState, type Bug, type Player } from "../sim";
import { BASE_KIND, MAX_BUG_RADIUS, bugDef } from "./registry";

/**
 * A player's spawn rate, bugs per second, for a life `ageSeconds` old: SPAWN_BASE_PER_S rising by
 * SPAWN_RAMP_PER_S2 a second, up to SPAWN_MAX_PER_S. It depends on the life only, never on the
 * arena's wave, so a late joiner gets the same opening as an early one.
 */
export function spawnRate(ageSeconds: number): number {
  return Math.min(SPAWN_MAX_PER_S, SPAWN_BASE_PER_S + SPAWN_RAMP_PER_S2 * ageSeconds);
}

/**
 * The life age, seconds, that `p`'s pressure follows at `tick`: their own life's age, held back
 * FIRST_LIFE_EASY_S on the first life of their session (never below 0). It never reads the
 * arena's age or wave, so a player joining an hour in meets the same pressure as one joining at
 * the start.
 */
export function pressureAge(p: Pick<Player, "lifeStartTick" | "firstLife">, tick: number): number {
  const age = (tick - p.lifeStartTick) * DT;
  return p.firstLife ? Math.max(0, age - FIRST_LIFE_EASY_S) : age;
}

/** The view square's centre on one axis: the camera's clamp at the wall (camera.ts clampAxis). */
function viewCentre(c: number, world: number): number {
  const lo = VIEW_MAX / 2 - VIEW_WALL_MARGIN;
  const hi = world - VIEW_MAX / 2 + VIEW_WALL_MARGIN;
  return Math.min(hi, Math.max(lo, c));
}

/**
 * Whether a bug at (x, y) could be on `p`'s screen: inside a square VIEW_MAX + 2 * VIEW_PAD wide
 * (plus the bug's radius) around where the camera centres on `p`. The square holds any screen
 * shape's view, clamped at the walls as the camera clamps.
 */
export function inView(p: { x: number; y: number }, x: number, y: number): boolean {
  const half = VIEW_MAX / 2 + VIEW_PAD + MAX_BUG_RADIUS;
  return Math.abs(x - viewCentre(p.x, WORLD_W)) < half && Math.abs(y - viewCentre(p.y, WORLD_H)) < half;
}

function inAnyView(state: ArenaState, x: number, y: number): boolean {
  for (const p of state.players) if (p.alive && inView(p, x, y)) return true;
  return false;
}

/** How many bugs of `kind` are alive in the arena. */
function countKind(state: ArenaState, kind: BugKind): number {
  let n = 0;
  for (const b of state.bugs) if (b.kind === kind) n++;
  return n;
}

/** Whether a spawn now, for a life `lifeSeconds` old, may be `kind` (never asked of the base kind). */
function eligible(state: ArenaState, kind: BugKind, lifeSeconds: number): boolean {
  const sp = bugDef(kind).spawn;
  return wave(state.tick) >= sp.unlockWave && sp.share(lifeSeconds) > 0 && countKind(state, kind) < sp.maxPerArena;
}

/**
 * The kind of the next spawn for a life whose pressure age (pressureAge: the life's age, held
 * back on a session's first life) is `lifeSeconds`. Only when some kind besides the base
 * one is eligible (unlocked by the arena's wave, a share above 0 for this life, under its cap) is
 * one number drawn: walking the eligible kinds in BUG_KINDS order and adding up their shares, the
 * first whose running total passes the draw is picked; else the base kind. With none eligible
 * nothing is drawn, so a crawler-only stretch replays exactly as before there were other kinds.
 */
function pickKind(state: ArenaState, lifeSeconds: number): BugKind {
  let any = false;
  for (let i = 1; i < BUG_KINDS.length && !any; i++) any = eligible(state, BUG_KINDS[i]!, lifeSeconds);
  if (!any) return BASE_KIND;
  const r = nextRandom(state.rng);
  let acc = 0;
  for (let i = 1; i < BUG_KINDS.length; i++) {
    const k = BUG_KINDS[i]!;
    if (!eligible(state, k, lifeSeconds)) continue;
    acc += bugDef(k).spawn.share(lifeSeconds);
    if (r < acc) return k;
  }
  return BASE_KIND;
}

/**
 * Tries to spawn one bug for `p`, out of the view of every player in a life (downed ones
 * included: they still watch the screen), clamped inside the walls by the largest kind's radius,
 * then picks its kind (pickKind). False if no try landed.
 */
function trySpawn(state: ArenaState, p: Player): boolean {
  const R = MAX_BUG_RADIUS;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const a = nextRandom(state.rng) * Math.PI * 2;
    const d = SPAWN_DIST_MIN + nextRandom(state.rng) * (SPAWN_DIST_MAX - SPAWN_DIST_MIN);
    const x = Math.min(WORLD_W - R, Math.max(R, p.x + Math.cos(a) * d));
    const y = Math.min(WORLD_H - R, Math.max(R, p.y + Math.sin(a) * d));
    if (inAnyView(state, x, y)) continue;
    const kind = pickKind(state, pressureAge(p, state.tick));
    const def = bugDef(kind);
    state.bugs.push({ id: state.nextBugId++, kind, x, y, vx: 0, vy: 0, hp: def.hp, target: p.id, phase: 0, phaseTicks: 0, dx: 0, dy: 0, travel: 0 });
    return true;
  }
  return false;
}

/**
 * The player bug `b` chases: the nearest player who is up (not down; ties: the earlier in the
 * list), except that a spawn-protected player is chased only by a bug already chasing them, so
 * bugs chasing someone else are never redirected at a newcomer. When that leaves no one (only
 * protected players are up), the nearest player who is up, who cannot be hurt yet anyway. Null
 * when no one is up.
 */
function chooseTarget(state: ArenaState, b: Bug): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  let any: Player | null = null;
  let anyD = Infinity;
  for (const p of state.players) {
    if (!canAct(p)) continue;
    const dx = p.x - b.x;
    const dy = p.y - b.y;
    const d = dx * dx + dy * dy;
    if (d < anyD) {
      anyD = d;
      any = p;
    }
    if (p.protectTicks > 0 && b.target !== p.id) continue;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ?? any;
}

/**
 * One tick of bugs:
 * 1. each player who is up has their budget grow by spawnRate(pressureAge) times DT (capped at
 *    SPAWN_BUDGET_CAP), and each whole bug owed spawns for them, chasing them, while the arena
 *    has room; its kind is picked by the mix (pickKind); a downed player's budget waits;
 * 2. each bug steps by its kind (kind.ts `step`), given its chooseTarget (or null: no one up);
 * 3. a bug touching a player who is up and can be hit (within PLAYER_RADIUS plus its kind's
 *    radius) strikes them (sim.ts strikePlayer: a hit, or a test shield spent) and is gone, with
 *    no score, whatever its kind and phase; bugs pass over downed players.
 */
export function stepBugs(state: ArenaState): void {
  const bugs = state.bugs;
  for (const p of state.players) {
    if (!canAct(p)) continue;
    p.budget = Math.min(SPAWN_BUDGET_CAP, p.budget + spawnRate(pressureAge(p, state.tick)) * DT);
    while (p.budget >= 1 && bugs.length < MAX_BUGS_PER_ARENA) {
      if (!trySpawn(state, p)) break;
      p.budget -= 1;
    }
  }
  for (const b of bugs) {
    const target = chooseTarget(state, b);
    b.target = target ? target.id : 0;
    bugDef(b.kind).step(b, target);
  }
  let keep = 0;
  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i]!;
    let gone = false;
    const touch = PLAYER_RADIUS + bugDef(b.kind).radius;
    for (const p of state.players) {
      if (!canBeHit(p)) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < touch * touch) {
        strikePlayer(state, p, b.kind);
        gone = true;
        break;
      }
    }
    if (!gone) bugs[keep++] = b;
  }
  bugs.length = keep;
}
