// The beetle (#80): a big, slow, steel-blue bug with a shell over its front 120 degrees. Shots
// that come at the shell spark off it (combat.ts shellBlocks: no damage, the streak still grows);
// shots from the side or behind hurt it. It turns slowly toward its target, so two players coming
// at it from different sides kill it fast, and one player who walks round it can shoot its back.
// - new: only until its first step, which faces it at its target ((1, 0) with none, or with a
//   young one: see below) and moves it to walk. A beetle is never in phase 0 after that, so every
//   snapshot row carries its facing in the v6 tail, and the browser and the bots see where its
//   shell points. It spawns out of every view, so its one tail-less row is never seen.
// - walk: each tick it turns its facing (b.dx, b.dy) toward its target by at most TURN_PER_TICK,
//   then walks along that facing at BEETLE_SPEED times how straight ahead its target is
//   (max(0, facing . to-target)): a target beside or behind it stalls it while it turns. With no
//   one up it stands, keeping its facing. It never counts phaseTicks (its ticksIn stays 0 on the
//   wire).
// A young target counts as none (#86): a target under BEETLE_FROM_S of pressure age is one the
// spawn mix spares beetles for, so the beetle neither turns toward nor walks at it; it stands,
// keeping its facing, until that life comes of age. So a late joiner meeting an arena's
// established beetles gets the opening an early joiner gets, who meets none in its first minute
// (direction.md "Fair drop-in"). Its body still hurts on contact.
// Contact is the stepper's, as for every kind.
import { DT, WORLD_H, WORLD_W } from "../constants";
import type { Bug, Player } from "../sim";
import type { BugKindDef } from "./kind";

/**
 * Collision radius, units: big, against a crawler's 12, and drawn on the circle shots meet
 * (draw/bugs/beetle.ts). The largest kind's, so it sets MAX_BUG_RADIUS and so every spawn clamp and
 * view check; at 17 all three `bun run skill` gates still pass on 240 and 480 late seeds.
 */
export const BEETLE_RADIUS = 17;
/** Its walking speed with its target dead ahead, units per second. */
export const BEETLE_SPEED = 80;
/** How fast it turns toward its target, radians per second, and per tick. */
export const BEETLE_TURN = 0.9;
export const TURN_PER_TICK = BEETLE_TURN * DT;
/** The shell covers this much either side of its facing, radians: its front 120 degrees. */
export const SHELL_HALF = Math.PI / 3;
/**
 * A life must be this old (pressure age) before a beetle spawns for it, and before a beetle turns
 * toward or walks at it (#86), seconds.
 */
export const BEETLE_FROM_S = 60;
/** Its share of a life's spawns at BEETLE_FROM_S, rising by BEETLE_SHARE_RAMP a second to BEETLE_SHARE_MAX. */
export const BEETLE_SHARE_START = 0.05;
export const BEETLE_SHARE_RAMP = 0.002;
export const BEETLE_SHARE_MAX = 0.1;
/** The most beetles alive in one arena. */
export const BEETLE_MAX_PER_ARENA = 3;

export const BEETLE_PHASES = ["new", "walk"] as const;
export const [NEW, WALK] = [0, 1] as const;

/** A beetle's share of the spawns for a life `lifeSeconds` old. */
export function beetleShare(lifeSeconds: number): number {
  if (lifeSeconds < BEETLE_FROM_S) return 0;
  return Math.min(BEETLE_SHARE_MAX, BEETLE_SHARE_START + BEETLE_SHARE_RAMP * (lifeSeconds - BEETLE_FROM_S));
}

/**
 * Turns `b`'s facing toward the unit vector (ux, uy) by at most TURN_PER_TICK, keeping it a unit
 * vector. Allocates nothing.
 */
function turnToward(b: Bug, ux: number, uy: number): void {
  const cross = b.dx * uy - b.dy * ux;
  const dot = b.dx * ux + b.dy * uy;
  const want = Math.atan2(cross, dot);
  const turn = Math.max(-TURN_PER_TICK, Math.min(TURN_PER_TICK, want));
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const dx = b.dx * c - b.dy * s;
  const dy = b.dx * s + b.dy * c;
  const d = Math.hypot(dx, dy);
  b.dx = dx / d;
  b.dy = dy / d;
}

export const beetle: BugKindDef = {
  id: "beetle",
  phases: BEETLE_PHASES,
  radius: BEETLE_RADIUS,
  hp: 8,
  points: 60,
  spawn: { unlockWave: 4, share: beetleShare, maxPerArena: BEETLE_MAX_PER_ARENA },
  shell: { cosHalf: Math.cos(SHELL_HALF) },
  step(b: Bug, target0: Player | null, targetAge: number) {
    b.vx = 0;
    b.vy = 0;
    // A young target is no target (#86).
    const target = target0 && targetAge >= BEETLE_FROM_S ? target0 : null;
    const tx = target ? target.x - b.x : 0;
    const ty = target ? target.y - b.y : 0;
    const d = Math.hypot(tx, ty);
    if (b.phase === NEW) {
      // Its first step: face its target (or along +x) and start walking next tick.
      b.phase = WALK;
      if (d > 0) {
        b.dx = tx / d;
        b.dy = ty / d;
      } else {
        b.dx = 1;
        b.dy = 0;
      }
      return;
    }
    if (d === 0) return;
    const ux = tx / d;
    const uy = ty / d;
    turnToward(b, ux, uy);
    const speed = BEETLE_SPEED * Math.max(0, b.dx * ux + b.dy * uy);
    b.vx = b.dx * speed;
    b.vy = b.dy * speed;
    const R = BEETLE_RADIUS;
    b.x = Math.min(WORLD_W - R, Math.max(R, b.x + b.vx * DT));
    b.y = Math.min(WORLD_H - R, Math.max(R, b.y + b.vy * DT));
  },
};
