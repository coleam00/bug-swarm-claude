// Helpers for the arena's simulation tests (combat, bugs, lives, pickups): arenas with players placed by
// hand, bugs and pickups placed by hand, and stepping with the personal spawn budget held at zero so only
// the bugs a test places are in play. Players placed by hand start without spawn protection or the
// first-life shield (#90). Their arenas hold the golden bug's timer off (#122), so a test that
// sets the clock by hand meets no golden bug; golden.test.ts turns it back on.
// Test-only; nothing in the game imports it.
import { newBug } from "./bugs/index";
import { BUG_KINDS, DOWN_TICKS, HITS_PER_LIFE, PICKUP_IDS, type BugKind, type PickupId } from "./constants";
import { pickupDef } from "./pickups/registry";
import { nextRandom } from "./rng";
import { clampInput, createArena, joinPlayer, stepArena, type ArenaState, type Bug, type FloorPickup, type Player } from "./sim";

export function arenaWith(...spots: [number, number][]): { a: ArenaState; ps: Player[] } {
  const a = createArena(1);
  a.golden.nextTick = Infinity;
  const ps = spots.map(([x, y], i) => {
    const p = joinPlayer(a, `p${i}`, i % 2 ? "spaces" : "tabs");
    p.x = x;
    p.y = y;
    p.invulnTicks = 0;
    p.protectTicks = 0;
    p.effect.fill(0);
    p.dashCooldown = 0;
    return p;
  });
  return { a, ps };
}

/** Places a bug of `kind` (the base kind, a crawler, by default) at (x, y), as a spawn would start it. */
export function placeBug(a: ArenaState, x: number, y: number, kind: BugKind = BUG_KINDS[0]): Bug {
  return newBug(a, kind, x, y, 0);
}

export function hold(p: Player, o: { mx?: number; my?: number; aim?: number; fire?: boolean; dash?: boolean; grenade?: boolean }): void {
  p.input = clampInput({ seq: p.input.seq + 1, mx: o.mx ?? 0, my: o.my ?? 0, aim: o.aim ?? 0, fire: o.fire ?? false, dash: o.dash ?? false, grenade: o.grenade ?? false });
}

/** Puts `p` down now: its last hit, from a bug placed on it, in one quiet step. */
export function downNow(a: ArenaState, p: Player): void {
  p.hits = HITS_PER_LIFE - 1;
  p.invulnTicks = 0;
  placeBug(a, p.x + 5, p.y);
  stepQuiet(a);
}

/** Bleeds a downed `p` out in one quiet step, as if DOWN_S had passed (the life ends in it). */
export function bleedNow(a: ArenaState, p: Player): void {
  p.downTick = a.tick - DOWN_TICKS;
  stepQuiet(a);
}

/** Steps `n` ticks with no spawns (every budget zeroed first). */
export function stepQuiet(a: ArenaState, n = 1): void {
  for (let i = 0; i < n; i++) {
    for (const p of a.players) p.budget = 0;
    stepArena(a);
  }
}

/** Places a pickup of `kind` on the floor at (x, y), as a drop would start it (#73). */
export function placePickup(a: ArenaState, x: number, y: number, kind: PickupId): FloorPickup {
  const f: FloorPickup = { id: a.nextPickupId++, kind, x, y, ticksLeft: pickupDef(kind).floorTicks };
  a.floor.push(f);
  return f;
}

/** Ticks left of `p`'s effect of `kind` (0: not active). */
export function effectOf(p: Player, kind: PickupId): number {
  return p.effect[PICKUP_IDS.indexOf(kind)]!;
}

/** Sets the drop generator so its next draw is under `limit` (a drop) or, with `above`, at least `limit`. */
export function nextDrop(a: ArenaState, limit: number, above = false): void {
  for (let s = 0; ; s++) {
    const r = nextRandom({ state: s });
    if (above ? r >= limit : r < limit) {
      a.dropRng.state = s;
      return;
    }
  }
}
