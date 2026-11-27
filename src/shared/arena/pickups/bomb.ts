// The refactor bomb (#78): used the moment it is taken. A ring goes out from the taker: every bug
// within BOMB_RADIUS that BOMB_CLEARS says it clears dies outright, and every other bug in range
// loses BOMB_DAMAGE hit points. Its kills score for the taker as usual. An instant pickup
// (durationTicks 0: no effect lasts, no effects bit, no HUD timer); its effect's one hook point is
// pickups/index.ts stepPickups, at the take.
import { DT, type BugKind } from "../constants";
import { bugDef } from "../bugs/registry";
import { mult } from "../combat";
import type { ArenaState, Player } from "../sim";
import { creditQueen } from "../bugs/queen";
import type { PickupDef } from "./kind";

/** How far the bomb reaches, centre to centre, world units. */
export const BOMB_RADIUS = 350;
/** What it does to a bug in range that it does not clear, hit points. */
export const BOMB_DAMAGE = 4;
/** How long it lies on the floor, seconds. */
export const BOMB_FLOOR_S = 12;

/**
 * Which kinds the bomb kills outright (true) or hits for BOMB_DAMAGE (false): the item's crawlers
 * and dashers die, everything else takes the damage (a 3 hp spitter and a 1 hp glob die of it too,
 * today; a hive queen (#85) takes the damage, credited to the taker's share of her reward). A Record
 * over BUG_KINDS, so a new kind does not compile until it says which.
 */
export const BOMB_CLEARS: Record<BugKind, boolean> = { crawler: true, dasher: true, spitter: false, glob: false, beetle: false, queen: false };

export const bomb: PickupDef = {
  id: "bomb",
  label: "Refactor bomb!",
  // Each kind's pickup chance, split evenly over the 4 pickups (#84, #78's rule): crawler 3.75%,
  // dasher and spitter 7.5%, beetle 15% in all; 0.9375%, 1.875% and 3.75% each. That is #90's x2.5
  // of the numbers #73 had halved for the late-joiner gate, set by measurement so an aimer takes 2 to
  // 3 pickups a life (`bun run skill`). The spitter (#72) drops as the dasher does; a beetle (#80)
  // takes 8 shots and drops twice what a dasher does. A glob is a shot in flight and drops nothing.
  drop: { crawler: 0.009375, dasher: 0.01875, spitter: 0.01875, glob: 0, beetle: 0.0375, queen: 0 },
  floorTicks: Math.round(BOMB_FLOOR_S / DT),
  durationTicks: 0,
};

const R2 = BOMB_RADIUS * BOMB_RADIUS;

/**
 * The effect: the bomb goes off on `p`. Every live bug whose centre is within BOMB_RADIUS of `p`'s
 * is killed (its kind cleared) or loses BOMB_DAMAGE and dies at 0. Each kill scores its kind's
 * points times `p`'s multiplier at `p`'s current streak, rounded half up to a whole number (a bomb is not a shot: the streak neither
 * grows nor resets), goes in events.kills by `p`, and `p`'s id goes in events.bombKills. A bug
 * already at 0 (killed by another bomb this step) is skipped. Allocates nothing but the kill rows.
 */
export function bombGoesOff(state: ArenaState, p: Player): void {
  const ev = state.events;
  for (const b of state.bugs) {
    if (b.hp <= 0) continue;
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    if (dx * dx + dy * dy > R2) continue;
    const before = b.hp;
    b.hp = BOMB_CLEARS[b.kind] ? 0 : b.hp - BOMB_DAMAGE;
    // A hive queen's damage is credited to the taker (#85, queen.ts).
    creditQueen(p, b, BOMB_DAMAGE, before);
    if (b.hp > 0) continue;
    const points = Math.round(bugDef(b.kind).points * mult(p.streak));
    p.score += points;
    p.kills++;
    ev.kills.push({ bug: b.id, by: p.id, x: b.x, y: b.y, points, kind: b.kind });
    ev.bombKills.push(p.id);
  }
}
