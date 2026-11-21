// Helpers for the arena's simulation tests (combat, bugs, lives): arenas with players placed by
// hand, bugs placed by hand, and stepping with the personal spawn budget held at zero so only
// the bugs a test places are in play. Players placed by hand start without spawn protection.
// Test-only; nothing in the game imports it.
import { bugDef } from "./bugs/registry";
import { BUG_KINDS, DOWN_TICKS, HITS_PER_LIFE, type BugKind } from "./constants";
import { clampInput, createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Player } from "./sim";

export function arenaWith(...spots: [number, number][]): { a: ArenaState; ps: Player[] } {
  const a = createArena(1);
  const ps = spots.map(([x, y], i) => {
    const p = joinPlayer(a, `p${i}`, i % 2 ? "spaces" : "tabs");
    p.x = x;
    p.y = y;
    p.invulnTicks = 0;
    p.protectTicks = 0;
    p.dashCooldown = 0;
    return p;
  });
  return { a, ps };
}

/** Places a bug of `kind` (the base kind, a crawler, by default) at (x, y), as a spawn would start it. */
export function placeBug(a: ArenaState, x: number, y: number, kind: BugKind = BUG_KINDS[0]): Bug {
  const b: Bug = { id: a.nextBugId++, kind, x, y, vx: 0, vy: 0, hp: bugDef(kind).hp, target: 0, phase: 0, phaseTicks: 0, dx: 0, dy: 0, travel: 0 };
  a.bugs.push(b);
  return b;
}

export function hold(p: Player, o: { mx?: number; my?: number; aim?: number; fire?: boolean; dash?: boolean }): void {
  p.input = clampInput({ seq: p.input.seq + 1, mx: o.mx ?? 0, my: o.my ?? 0, aim: o.aim ?? 0, fire: o.fire ?? false, dash: o.dash ?? false });
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
