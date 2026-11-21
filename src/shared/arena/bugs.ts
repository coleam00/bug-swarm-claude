// Crawlers (#55): personal spawn pressure, spawning out of view, chasing and contact. Stepped by
// sim.ts stepArena. Pure and deterministic. One kind for now; the per-kind seam (architecture.md,
// "Bug kinds") is built by the item that adds the second kind, but every bug already carries
// its kind.
import {
  CRAWLER,
  CRAWLER_HP,
  CRAWLER_RADIUS,
  CRAWLER_SPEED,
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
} from "./constants";
import { nextRandom } from "./rng";
import { canBeHit, hitPlayer, type ArenaState, type Bug, type Player } from "./sim";

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
  const half = VIEW_MAX / 2 + VIEW_PAD + CRAWLER_RADIUS;
  return Math.abs(x - viewCentre(p.x, WORLD_W)) < half && Math.abs(y - viewCentre(p.y, WORLD_H)) < half;
}

function inAnyView(state: ArenaState, x: number, y: number): boolean {
  for (const p of state.players) if (p.alive && inView(p, x, y)) return true;
  return false;
}

/** Tries to spawn one crawler for `p`, out of every alive player's view. False if no try landed. */
function trySpawn(state: ArenaState, p: Player): boolean {
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const a = nextRandom(state.rng) * Math.PI * 2;
    const d = SPAWN_DIST_MIN + nextRandom(state.rng) * (SPAWN_DIST_MAX - SPAWN_DIST_MIN);
    const x = Math.min(WORLD_W - CRAWLER_RADIUS, Math.max(CRAWLER_RADIUS, p.x + Math.cos(a) * d));
    const y = Math.min(WORLD_H - CRAWLER_RADIUS, Math.max(CRAWLER_RADIUS, p.y + Math.sin(a) * d));
    if (inAnyView(state, x, y)) continue;
    state.bugs.push({ id: state.nextBugId++, kind: CRAWLER, x, y, vx: 0, vy: 0, hp: CRAWLER_HP, target: p.id });
    return true;
  }
  return false;
}

/**
 * The player bug `b` chases: the nearest alive player (ties: the earlier in the list), except that
 * a spawn-protected player is chased only by a bug already chasing them, so bugs chasing someone
 * else are never redirected at a newcomer. When that leaves no one (only protected players are
 * alive), the nearest alive player, who cannot be hurt yet anyway. Null when no one is alive.
 */
function chooseTarget(state: ArenaState, b: Bug): Player | null {
  let best: Player | null = null;
  let bestD = Infinity;
  let any: Player | null = null;
  let anyD = Infinity;
  for (const p of state.players) {
    if (!p.alive) continue;
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

const TOUCH = PLAYER_RADIUS + CRAWLER_RADIUS;

/**
 * One tick of bugs:
 * 1. each alive player's budget grows by spawnRate(pressureAge) times DT (capped at
 *    SPAWN_BUDGET_CAP), and each whole bug owed spawns for them, chasing them, while the arena
 *    has room;
 * 2. each bug chases its chooseTarget at CRAWLER_SPEED (no one alive: it stands);
 * 3. a bug touching a player who canBeHit costs them a hit and is gone, with no score.
 */
export function stepBugs(state: ArenaState): void {
  const bugs = state.bugs;
  for (const p of state.players) {
    if (!p.alive) continue;
    p.budget = Math.min(SPAWN_BUDGET_CAP, p.budget + spawnRate(pressureAge(p, state.tick)) * DT);
    while (p.budget >= 1 && bugs.length < MAX_BUGS_PER_ARENA) {
      if (!trySpawn(state, p)) break;
      p.budget -= 1;
    }
  }
  for (const b of bugs) {
    const target = chooseTarget(state, b);
    if (!target) {
      b.vx = 0;
      b.vy = 0;
      b.target = 0;
      continue;
    }
    b.target = target.id;
    const dx = target.x - b.x;
    const dy = target.y - b.y;
    const d = Math.hypot(dx, dy);
    const step = Math.min(d, CRAWLER_SPEED * DT);
    if (d > 0) {
      b.vx = (dx / d) * CRAWLER_SPEED;
      b.vy = (dy / d) * CRAWLER_SPEED;
      b.x += (dx / d) * step;
      b.y += (dy / d) * step;
    }
  }
  let keep = 0;
  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i]!;
    let gone = false;
    for (const p of state.players) {
      if (!canBeHit(p)) continue;
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < TOUCH * TOUCH) {
        hitPlayer(state, p);
        gone = true;
        break;
      }
    }
    if (!gone) bugs[keep++] = b;
  }
  bugs.length = keep;
}
