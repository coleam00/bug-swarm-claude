// Pickups (#73, architecture.md "Pickups (the recipe)"): drops from kills, the floor's cap and
// expiry, effects counting down, and who takes a pickup. Stepped by sim.ts stepArena after shots.
// Pure and deterministic: every drop is drawn from the arena's own drop generator (state.dropRng),
// never state.rng, so bug spawns and shot spread replay exactly as with no pickups. What a pickup
// is lives in its own file (kind.ts, registry.ts); this file treats every pickup the same.
import { MAX_PICKUPS_PER_ARENA, PICKUP_IDS, PICKUP_RADIUS, PLAYER_RADIUS, WORLD_H, WORLD_W, type BugKind, type PickupId } from "../constants";
import { nextRandom } from "../rng";
import { sweepDeadBugs } from "../combat";
import { canAct, type ArenaState } from "../sim";
import { bomb, bombGoesOff } from "./bomb";
import { PICKUP_DEFS } from "./registry";

/**
 * The pickup a kill of `kind` drops for a draw `r` in [0, 1), or null: walking PICKUP_IDS in order
 * and adding up each pickup's chance for that kind, the first whose running total passes `r`.
 */
export function dropFor(kind: BugKind, r: number): PickupId | null {
  let acc = 0;
  for (const id of PICKUP_IDS) {
    acc += PICKUP_DEFS[id].drop[kind];
    if (r < acc) return id;
  }
  return null;
}

const TOUCH = PLAYER_RADIUS + PICKUP_RADIUS;

/**
 * One tick of pickups, after shots (so this step's kills can drop):
 * 1. effects: each active effect of each player who is up counts down a tick (a downed player has
 *    none: going down clears them);
 * 2. age: each floor pickup counts down, and one at 0 is gone;
 * 3. drops: every kill this step (scored or not) draws exactly one number from state.dropRng,
 *    always, so the generator's use never depends on the cap; the pickup it picks (dropFor), if
 *    any, lands at the kill clamped inside the walls, unless MAX_PICKUPS_PER_ARENA already lie on
 *    the floor (then it is lost, never queued);
 * 4. touch: each floor pickup, in order, goes to the first player in the list who is up and within
 *    PLAYER_RADIUS + PICKUP_RADIUS: its effect is set to its full duration (taking one you already
 *    have refreshes it; an instant pickup's is 0), events.pickups says who took what, and it leaves
 *    the floor. A refactor bomb goes off there and then (#78, bomb.ts bombGoesOff);
 * 5. after a bomb: its kills draw their drops as in 3 (landing on the floor after this step's
 *    touches, so they can be taken from the next step on), and the bugs it killed leave the arena
 *    now (combat.ts sweepDeadBugs), so none takes another step.
 * The floor is compacted in place.
 */
export function stepPickups(state: ArenaState): void {
  const ev = state.events;
  for (const p of state.players) {
    if (!canAct(p)) continue;
    const e = p.effect;
    for (let i = 0; i < e.length; i++) if (e[i]! > 0) e[i]!--;
  }
  const floor = state.floor;
  let keep = 0;
  for (let i = 0; i < floor.length; i++) {
    const f = floor[i]!;
    if (--f.ticksLeft > 0) floor[keep++] = f;
  }
  floor.length = keep;
  dropKills(state, 0);
  const shotKills = ev.kills.length;
  keep = 0;
  for (let i = 0; i < floor.length; i++) {
    const f = floor[i]!;
    let taken = false;
    for (const p of state.players) {
      if (!canAct(p)) continue;
      const dx = p.x - f.x;
      const dy = p.y - f.y;
      if (dx * dx + dy * dy > TOUCH * TOUCH) continue;
      p.effect[PICKUP_IDS.indexOf(f.kind)] = PICKUP_DEFS[f.kind].durationTicks;
      ev.pickups.push({ player: p.id, kind: f.kind });
      if (f.kind === bomb.id) bombGoesOff(state, p);
      taken = true;
      break;
    }
    if (!taken) floor[keep++] = f;
  }
  floor.length = keep;
  if (ev.kills.length > shotKills) {
    dropKills(state, shotKills);
    sweepDeadBugs(state);
  }
}

/** Each kill from index `from` of this step's kills draws one number and maybe drops (step 3). */
function dropKills(state: ArenaState, from: number): void {
  const kills = state.events.kills;
  const floor = state.floor;
  for (let i = from; i < kills.length; i++) {
    const k = kills[i]!;
    const id = dropFor(k.kind, nextRandom(state.dropRng));
    if (id === null || floor.length >= MAX_PICKUPS_PER_ARENA) continue;
    const x = Math.min(WORLD_W - PICKUP_RADIUS, Math.max(PICKUP_RADIUS, k.x));
    const y = Math.min(WORLD_H - PICKUP_RADIUS, Math.max(PICKUP_RADIUS, k.y));
    floor.push({ id: state.nextPickupId++, kind: id, x, y, ticksLeft: PICKUP_DEFS[id].floorTicks });
  }
}
