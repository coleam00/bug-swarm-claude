// The spitter (#72): a fat, acid-green bug that keeps its distance, swells, then lobs a slow glob
// at where its target is going to be.
// - keep: holds KEEP_NEAR to KEEP_FAR units from the nearest player who is up: closing in or
//   backing off at MOVE_SPEED outside the band, strafing slowly round them inside it (one way by
//   its id, turning back when a wall stops it). Once it has spent RELOAD_TICKS in keep (counted
//   from its spawn too) with its target within TELL_RANGE, it starts its tell, but never at a
//   life whose pressure age is under SPITTER_FROM_S (owner ruling, #72): a spitter spawns for no
//   life younger than that, so a newcomer is not singled out by an arena full of spitters. It
//   circles them without telling. The rule is on the tell's start only: the glob is aimed at
//   whoever is the nearest player up when the tell ends, at any age, so a young life that steps
//   nearer during a tell begun at an older one takes the glob.
// - tell: stands still, swelling and glowing (the browser draws it), for TELL_TICKS ticks, the
//   first one included, facing where its target was when it began. It never cancels. On its last
//   tick it aims with lead (leadAim) and launches one glob (glob.ts) from its mouth: the stepper
//   does the launch (bugs/index.ts launch), so the glob caps hold there. With no one up by then,
//   nothing is launched and it goes back to keep.
// - spit: stands for SPIT_TICKS ticks (the recoil), then keeps its distance again.
// Contact is the stepper's, as for every kind. A sidestep or a dash beats a glob, or a shot does.
import { DT, MAX_BUGS_PER_ARENA, MAX_SPEED, WORLD_H, WORLD_W } from "../constants";
import type { Bug, Player } from "../sim";
import { GLOB_RADIUS, GLOB_SPEED } from "./glob";
import { STEP_LAUNCH, type BugKindDef } from "./kind";

/** Collision radius, units: a crawler's 12, so MAX_BUG_RADIUS and every spawn and view check stay as they were (a 15 moved the late gate from 0.84x to 0.81x on 240 seeds with no spitter spawning). It is drawn fatter (draw/bugs/spitter.ts). */
export const SPITTER_RADIUS = 12;
/** The band it keeps from its target, units. */
export const KEEP_NEAR = 260;
export const KEEP_FAR = 360;
/** How far inside the band it stops when it comes back to it, units. */
const BAND_IN = 10;
/** Its speed closing in or backing off to the band, and strafing inside it, units per second. */
export const MOVE_SPEED = 120;
export const STRAFE_SPEED = 60;
/** Ticks in keep before it may tell again (from its spawn too): 2 s. */
export const RELOAD_TICKS = Math.round(2 / DT);
/** It tells only with its target this close, units. */
export const TELL_RANGE = 450;
/** How long the tell lasts, seconds, and in ticks. */
export const TELL_S = 0.8;
export const TELL_TICKS = Math.round(TELL_S / DT);
/** The recoil after a spit, ticks it stands still. */
export const SPIT_TICKS = Math.round(0.3 / DT);
/** Where a glob leaves from: this far from its centre along the aim, units (bugs/index.ts launch). */
export const MUZZLE = SPITTER_RADIUS + GLOB_RADIUS;
/** The longest lead it aims for, seconds of glob flight. */
export const LEAD_MAX_S = 2;
/** A life must be this old (pressure age) before a spitter spawns for it or starts a tell at it, seconds. */
export const SPITTER_FROM_S = 60;
/** Its share of a life's spawns at SPITTER_FROM_S, rising by SPITTER_SHARE_RAMP a second to SPITTER_SHARE_MAX. */
export const SPITTER_SHARE_START = 0.08;
export const SPITTER_SHARE_RAMP = 0.004;
export const SPITTER_SHARE_MAX = 0.2;
/** The most spitters alive in one arena (owner ruling, #72). */
export const SPITTER_MAX_PER_ARENA = 6;

export const SPITTER_PHASES = ["keep", "tell", "spit"] as const;
export const [KEEP, TELL, SPIT] = [0, 1, 2] as const;

/** A spitter's share of the spawns for a life `lifeSeconds` old. */
export function spitterShare(lifeSeconds: number): number {
  if (lifeSeconds < SPITTER_FROM_S) return 0;
  return Math.min(SPITTER_SHARE_MAX, SPITTER_SHARE_START + SPITTER_SHARE_RAMP * (lifeSeconds - SPITTER_FROM_S));
}

/**
 * The unit direction from a spitter at (sx, sy) to aim a glob leaving its muzzle now at
 * GLOB_SPEED, first moving a tick from now, so it meets a target at (px, py) moving at (vx, vy) (clamped to MAX_SPEED, so a dash
 * does not fling the aim), written into `out`. Simple lead: the flight time is found by fixed
 * point (a glob is no faster than a running player, so the closed form can have no root), capped
 * at LEAD_MAX_S. Straight at the target when the aim point is the muzzle itself. Allocates nothing.
 */
export function leadAim(sx: number, sy: number, px: number, py: number, vx: number, vy: number, out: { dx: number; dy: number }): void {
  const v = Math.hypot(vx, vy);
  if (v > MAX_SPEED) {
    vx *= MAX_SPEED / v;
    vy *= MAX_SPEED / v;
  }
  let t = flight(Math.hypot(px - sx, py - sy));
  let ax = px;
  let ay = py;
  for (let i = 0; i < 8; i++) {
    // The glob leaves a tick from now: the target moves that tick as well as during the flight.
    ax = px + vx * (t + DT);
    ay = py + vy * (t + DT);
    t = flight(Math.hypot(ax - sx, ay - sy));
  }
  let dx = ax - sx;
  let dy = ay - sy;
  let d = Math.hypot(dx, dy);
  if (d === 0) {
    dx = px - sx;
    dy = py - sy;
    d = Math.hypot(dx, dy);
  }
  if (d === 0) {
    out.dx = 1;
    out.dy = 0;
    return;
  }
  out.dx = dx / d;
  out.dy = dy / d;
}

/** A glob's flight time to a point `d` from the spitter's centre, seconds, capped at LEAD_MAX_S. */
function flight(d: number): number {
  return Math.min(LEAD_MAX_S, Math.max(0, d - MUZZLE) / GLOB_SPEED);
}

function enter(b: Bug, phase: number): void {
  b.phase = phase;
  b.phaseTicks = 0;
  b.vx = 0;
  b.vy = 0;
}

/** One keep tick: back to the band, or strafe inside it; then maybe start the tell. */
function keep(b: Bug, target: Player | null, targetAge: number): void {
  b.vx = 0;
  b.vy = 0;
  if (!target) {
    b.phaseTicks++;
    return;
  }
  const tx = target.x - b.x;
  const ty = target.y - b.y;
  const d = Math.hypot(tx, ty);
  if (b.phaseTicks >= RELOAD_TICKS && d <= TELL_RANGE && targetAge >= SPITTER_FROM_S) {
    enter(b, TELL);
    if (d > 0) {
      b.dx = tx / d;
      b.dy = ty / d;
    } else {
      b.dx = 1;
      b.dy = 0;
    }
    return;
  }
  b.phaseTicks++;
  if (d === 0) return;
  const ux = tx / d;
  const uy = ty / d;
  // Its strafe direction lives in `travel` (+1 or -1), first set by its id.
  if (b.travel === 0) b.travel = b.id & 1 ? 1 : -1;
  const strafing = d >= KEEP_NEAR && d <= KEEP_FAR;
  // Back to the band, stopping BAND_IN inside it, so strafing does not ride its edge.
  if (d > KEEP_FAR) {
    const s = Math.min(MOVE_SPEED, (d - KEEP_FAR + BAND_IN) / DT);
    b.vx = ux * s;
    b.vy = uy * s;
  } else if (d < KEEP_NEAR) {
    const s = Math.min(MOVE_SPEED, (KEEP_NEAR + BAND_IN - d) / DT);
    b.vx = -ux * s;
    b.vy = -uy * s;
  } else {
    b.vx = -uy * b.travel * STRAFE_SPEED;
    b.vy = ux * b.travel * STRAFE_SPEED;
  }
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  if (strafing) {
    // Round the target, not off along the tangent: back to the distance it had.
    const rx = b.x - target.x;
    const ry = b.y - target.y;
    const r = Math.hypot(rx, ry);
    b.x = target.x + (rx / r) * d;
    b.y = target.y + (ry / r) * d;
  }
  const R = SPITTER_RADIUS;
  let wall = false;
  if (b.x < R || b.x > WORLD_W - R) {
    b.x = Math.min(WORLD_W - R, Math.max(R, b.x));
    wall = true;
  }
  if (b.y < R || b.y > WORLD_H - R) {
    b.y = Math.min(WORLD_H - R, Math.max(R, b.y));
    wall = true;
  }
  if (wall && strafing) b.travel = -b.travel;
}

export const spitter: BugKindDef = {
  id: "spitter",
  phases: SPITTER_PHASES,
  radius: SPITTER_RADIUS,
  hp: 3,
  points: 30,
  spawn: { unlockWave: 3, share: spitterShare, maxPerArena: SPITTER_MAX_PER_ARENA },
  launches: [{ kind: "glob", speed: GLOB_SPEED, count: 1, capAt: MAX_BUGS_PER_ARENA }],
  step(b, target, targetAge) {
    switch (b.phase) {
      case TELL:
        b.vx = 0;
        b.vy = 0;
        if (++b.phaseTicks < TELL_TICKS) return;
        if (!target) {
          enter(b, KEEP);
          return;
        }
        leadAim(b.x, b.y, target.x, target.y, target.vx, target.vy, b);
        enter(b, SPIT);
        return STEP_LAUNCH;
      case SPIT:
        b.vx = 0;
        b.vy = 0;
        if (++b.phaseTicks < SPIT_TICKS) return;
        enter(b, KEEP);
        return;
    }
    keep(b, target, targetAge);
  },
};
