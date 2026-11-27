// The golden bug's arena rules (#122): when and where it appears, and whose kill the arena hears
// about. How it moves, what it pays and that it hurts no one is its kind file, bugs/golden.ts, on
// the bug-kind seam like any other kind. Pure and deterministic: its timer and spot draw from
// state.goldenRng, never state.rng, so spawns and spread replay as they would without it.
// - Timer (stepGolden): a slot comes every GOLDEN_EVERY_MIN_S to GOLDEN_EVERY_MAX_S (uniform, about
//   once a minute), counted from the last slot, not the last golden bug. A slot finding a golden
//   bug alive, nobody up, or the arena at MAX_BUGS_PER_ARENA bugs is skipped, not queued.
// - Spot: GOLDEN_SPAWN_DIST from a player who is up, picked at random, at a random angle, kept
//   GOLDEN_WALL_CLEAR inside the walls: in that player's view as it appears (it flees at once;
//   its gold minimap dot and edge arrow, from the snapshot's `g`, lead players to it).
// - Kill (goldenKills, after pickups, so a shot kill and a bomb kill are both in the step's kills):
//   events.golden gets the killer's id, for the arena-wide banner. A kill by a finished life (by 0)
//   scores nothing and names no one; expiry is no kill.
import { GOLDEN_RADIUS } from "./bugs/golden";
import { newBug } from "./bugs/index";
import { DT, MAX_BUGS_PER_ARENA, WORLD_H, WORLD_W, type BugKind } from "./constants";
import { nextRandom, type Rng } from "./rng";
import { canAct, type ArenaState } from "./sim";

/** The kind's id, named once. */
export const GOLDEN_KIND: BugKind = "golden";
/** Slots come this far apart, seconds: uniform between the two (a minute on average). */
export const GOLDEN_EVERY_MIN_S = 45;
export const GOLDEN_EVERY_MAX_S = 75;
/**
 * It appears this far from the player it is placed for, units. The camera keeps 360,000 units² in
 * view (camera.ts), so a 390x844 portrait phone sees about 408 units across: 180 is inside any
 * screen as it appears.
 */
export const GOLDEN_SPAWN_DIST = 180;
/** ...and at least this far inside every wall, units. */
export const GOLDEN_WALL_CLEAR = 60;

/** Ticks from one slot to the next, drawn from `rng`. */
export function goldenInterval(rng: Rng): number {
  return Math.round((GOLDEN_EVERY_MIN_S + nextRandom(rng) * (GOLDEN_EVERY_MAX_S - GOLDEN_EVERY_MIN_S)) / DT);
}

function goldenAlive(state: ArenaState): boolean {
  for (const b of state.bugs) if (b.kind === GOLDEN_KIND) return true;
  return false;
}

/**
 * One step of the timer (sim.ts stepArena, before bugs): on a slot's tick, the next slot is
 * scheduled, then, unless a golden bug is alive, the arena is full or nobody is up, one appears
 * GOLDEN_SPAWN_DIST from a player who is up (drawn uniformly), at a drawn angle, clamped
 * GOLDEN_WALL_CLEAR inside the walls. Allocates nothing.
 */
export function stepGolden(state: ArenaState): void {
  const g = state.golden;
  if (state.tick < g.nextTick) return;
  g.nextTick += goldenInterval(state.goldenRng);
  if (state.bugs.length >= MAX_BUGS_PER_ARENA || goldenAlive(state)) return;
  let up = 0;
  for (const p of state.players) if (canAct(p)) up++;
  if (up === 0) return;
  let pick = Math.floor(nextRandom(state.goldenRng) * up);
  for (const p of state.players) {
    if (!canAct(p) || pick-- > 0) continue;
    const a = nextRandom(state.goldenRng) * Math.PI * 2;
    const lo = Math.max(GOLDEN_WALL_CLEAR, GOLDEN_RADIUS);
    const x = Math.min(WORLD_W - lo, Math.max(lo, p.x + Math.cos(a) * GOLDEN_SPAWN_DIST));
    const y = Math.min(WORLD_H - lo, Math.max(lo, p.y + Math.sin(a) * GOLDEN_SPAWN_DIST));
    newBug(state, GOLDEN_KIND, x, y, p.id);
    return;
  }
}

/** Names the killer of each golden bug killed this step that scored (sim.ts stepArena, after pickups). */
export function goldenKills(state: ArenaState): void {
  for (const k of state.events.kills) if (k.kind === GOLDEN_KIND && k.by !== 0) state.events.golden.push(k.by);
}
