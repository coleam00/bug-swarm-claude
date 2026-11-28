// The grenade (#130): a secondary weapon on a cooldown whose blast also hurts players (owner ruling:
// the one exception to "shots never touch players"). Stepped by sim.ts stepArena after shots. Pure,
// deterministic, and it draws no randomness.
// - Throw: a press (input.grenade after a tick without it) by a player who is up, with the cooldown
//   run out, throws one along the aim: it lands GRENADE_RANGE out (kept inside the walls) after
//   GRENADE_FLIGHT_S, blinks GRENADE_BLINK_S, then goes off. The cooldown is GRENADE_COOLDOWN_S from
//   the throw; a press before then is dropped, not kept. No inventory, no pickups.
// - Blast on bugs: every live bug within GRENADE_RADIUS loses GRENADE_DAMAGE (a shell does not
//   block it). A kill scores its kind's points times the thrower's multiplier, as a refactor bomb's
//   kills do (pickups/bomb.ts): the streak neither grows nor resets. Only the life that threw it is
//   credited; a thrower who left or whose life ended scores nothing (the kill row's `by` is 0).
// - Blast on players: every player within GRENADE_RADIUS who can be hit (canBeHit: the thrower too,
//   either team, fill bots too) takes one hit through strikePlayer, so a test shield blocks it and
//   spawn protection, a dash and a hit's untouchable time save you. Downed players are not hit.
import { bugDef } from "./bugs/registry";
import { creditQueen } from "./bugs/queen";
import { mult, sweepDeadBugs } from "./combat";
import {
  GRENADE_BLINK_TICKS,
  GRENADE_COOLDOWN_TICKS,
  GRENADE_DAMAGE,
  GRENADE_FLIGHT_TICKS,
  GRENADE_RADIUS,
  GRENADE_RANGE,
  WORLD_H,
  WORLD_W,
} from "./constants";
import { canAct, canBeHit, strikePlayer, type ArenaState, type Grenade, type Player } from "./sim";

const R2 = GRENADE_RADIUS * GRENADE_RADIUS;

/** Ticks from a throw's step to the step it goes off in. */
export const GRENADE_FUSE_TICKS = GRENADE_FLIGHT_TICKS + GRENADE_BLINK_TICKS;

/**
 * One step of grenades: every grenade whose step has come goes off (oldest first), then every
 * player who is up counts their cooldown down and throws on a press. Allocates only a thrown
 * grenade and the blast's kill rows.
 */
export function stepGrenades(state: ArenaState): void {
  const list = state.grenades;
  if (list.length > 0) {
    let keep = 0;
    let blew = false;
    for (let i = 0; i < list.length; i++) {
      const g = list[i]!;
      if (g.explodeTick <= state.tick) {
        blast(state, g);
        blew = true;
      } else list[keep++] = g;
    }
    list.length = keep;
    if (blew) sweepDeadBugs(state);
  }
  for (const p of state.players) {
    if (!canAct(p)) continue;
    if (p.grenadeCooldown > 0) p.grenadeCooldown--;
    const pressed = p.input.grenade && !p.grenadeWas;
    p.grenadeWas = p.input.grenade;
    if (pressed && p.grenadeCooldown === 0) throwGrenade(state, p);
  }
}

function throwGrenade(state: ArenaState, p: Player): void {
  const toX = Math.min(WORLD_W, Math.max(0, p.x + Math.cos(p.aim) * GRENADE_RANGE));
  const toY = Math.min(WORLD_H, Math.max(0, p.y + Math.sin(p.aim) * GRENADE_RANGE));
  const g: Grenade = { owner: p.id, life: p.lifeStartTick, tick: state.tick, fromX: p.x, fromY: p.y, toX, toY, explodeTick: state.tick + GRENADE_FUSE_TICKS };
  p.grenadeCooldown = GRENADE_COOLDOWN_TICKS;
  state.grenades.push(g);
  state.events.grenadesThrown.push(g);
}

/** The player credited for `g`: its thrower, still in the life that threw it; else null. */
function creditFor(state: ArenaState, g: Grenade): Player | null {
  for (const p of state.players) if (p.id === g.owner) return p.alive && p.lifeStartTick === g.life ? p : null;
  return null;
}

/** `g` goes off at its landing point: bugs first (kills in events.kills), then players. */
function blast(state: ArenaState, g: Grenade): void {
  const ev = state.events;
  const owner = creditFor(state, g);
  for (const b of state.bugs) {
    if (b.hp <= 0) continue;
    const dx = b.x - g.toX;
    const dy = b.y - g.toY;
    if (dx * dx + dy * dy > R2) continue;
    const before = b.hp;
    b.hp -= GRENADE_DAMAGE;
    if (owner) creditQueen(owner, b, GRENADE_DAMAGE, before);
    if (b.hp > 0) continue;
    if (owner) {
      const points = Math.round(bugDef(b.kind).points * mult(owner.streak));
      owner.score += points;
      owner.kills++;
      ev.kills.push({ bug: b.id, by: owner.id, x: b.x, y: b.y, points, kind: b.kind });
    } else ev.kills.push({ bug: b.id, by: 0, x: b.x, y: b.y, points: 0, kind: b.kind });
  }
  for (const p of state.players) {
    if (!canBeHit(p)) continue;
    const dx = p.x - g.toX;
    const dy = p.y - g.toY;
    if (dx * dx + dy * dy > R2) continue;
    strikePlayer(state, p, null);
  }
}
