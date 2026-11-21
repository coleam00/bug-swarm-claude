// Helpers for the arena's simulation tests (combat, bugs, lives): arenas with players placed by
// hand, bugs placed by hand, and stepping with the personal spawn budget held at zero so only
// the bugs a test places are in play. Test-only; nothing in the game imports it.
import { CRAWLER, CRAWLER_HP } from "./constants";
import { clampInput, createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Player } from "./sim";

export function arenaWith(...spots: [number, number][]): { a: ArenaState; ps: Player[] } {
  const a = createArena(1);
  const ps = spots.map(([x, y], i) => {
    const p = joinPlayer(a, `p${i}`, i % 2 ? "spaces" : "tabs");
    p.x = x;
    p.y = y;
    p.invulnTicks = 0;
    p.dashCooldown = 0;
    return p;
  });
  return { a, ps };
}

export function placeBug(a: ArenaState, x: number, y: number): Bug {
  const b: Bug = { id: a.nextBugId++, kind: CRAWLER, x, y, vx: 0, vy: 0, hp: CRAWLER_HP, target: 0 };
  a.bugs.push(b);
  return b;
}

export function hold(p: Player, o: { mx?: number; my?: number; aim?: number; fire?: boolean; dash?: boolean }): void {
  p.input = clampInput({ seq: p.input.seq + 1, mx: o.mx ?? 0, my: o.my ?? 0, aim: o.aim ?? 0, fire: o.fire ?? false, dash: o.dash ?? false });
}

/** Steps `n` ticks with no spawns (every budget zeroed first). */
export function stepQuiet(a: ArenaState, n = 1): void {
  for (let i = 0; i < n; i++) {
    for (const p of a.players) p.budget = 0;
    stepArena(a);
  }
}
