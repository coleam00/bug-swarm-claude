// Down and revive (#59), stepped by sim.ts stepArena after shots. Pure and deterministic. The
// last hit puts a player down (sim.ts hitPlayer); here a downed player is revived by anyone, of
// either team, who stays close for REVIVE_S, or bleeds out after DOWN_S and the life ends.
import { DOWN_TICKS, HITS_PER_LIFE, REVIVE_POINTS, REVIVE_PROTECT_TICKS, REVIVE_RANGE, REVIVE_TICKS } from "./constants";
import { canAct, endLife, type ArenaState, type Player } from "./sim";

const RANGE2 = REVIVE_RANGE * REVIVE_RANGE;

/** Whether `h` can revive `p` this step: in the arena, up, not `p`, within REVIVE_RANGE (inclusive). */
function canRevive(p: Player, h: Player): boolean {
  if (h === p || !canAct(h)) return false;
  const dx = h.x - p.x;
  const dy = h.y - p.y;
  return dx * dx + dy * dy <= RANGE2;
}

function byId(state: ArenaState, id: number): Player | null {
  for (const p of state.players) if (p.id === id) return p;
  return null;
}

/**
 * One step of every downed player, in index order:
 * 1. a player who went down this step only waits (progress starts on the next step);
 * 2. one holder per down: the holder must still be in the arena, up and in range, or its progress
 *    is lost (reviver and progress back to 0); with no holder, the nearest player in range who
 *    is up takes hold (ties: the earlier in the list) from 0. So a second player in range scores
 *    nothing, and when the holder walks off, goes down or leaves, the next one starts over;
 * 3. the holder's progress counts; on its REVIVE_TICKS-th step in a row the player is revived with
 *    one hit left and REVIVE_PROTECT_S of protection, and the holder scores REVIVE_POINTS on its
 *    life (so for its team). The revive ends the down, so it counts once per down; it beats a
 *    bleed-out in the same step. The holder's streak is untouched;
 * 4. else, DOWN_TICKS after going down, the player bleeds out: the life ends (events.livesEnded).
 * A downed player can't revive anyone.
 */
export function stepDowns(state: ArenaState): void {
  const ev = state.events;
  for (const p of state.players) {
    if (!p.down) continue;
    if (p.downTick !== state.tick) {
      let holder = p.reviver !== 0 ? byId(state, p.reviver) : null;
      if (p.reviver !== 0 && !(holder && canRevive(p, holder))) {
        holder = null;
        p.reviver = 0;
        p.reviveTicks = 0;
      }
      if (!holder) {
        let bestD = Infinity;
        for (const h of state.players) {
          if (!canRevive(p, h)) continue;
          const dx = h.x - p.x;
          const dy = h.y - p.y;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            holder = h;
          }
        }
        if (holder) {
          p.reviver = holder.id;
          p.reviveTicks = 0;
        }
      }
      if (holder) {
        p.reviveTicks++;
        if (p.reviveTicks >= REVIVE_TICKS) {
          p.down = false;
          p.hits = HITS_PER_LIFE - 1;
          p.invulnTicks = REVIVE_PROTECT_TICKS;
          p.reviver = 0;
          p.reviveTicks = 0;
          holder.score += REVIVE_POINTS;
          ev.revives.push({ id: p.id, by: holder.id, points: REVIVE_POINTS });
          continue;
        }
      }
    }
    if (state.tick - p.downTick >= DOWN_TICKS) ev.livesEnded.push(endLife(state, p));
  }
}
