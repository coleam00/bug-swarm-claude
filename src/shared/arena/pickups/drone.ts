// The CI drone (#84): for DRONE_S a small drone orbits you and fires on its own, DRONE_FIRE_RATE
// shots a second, at the nearest live bug within DRONE_RANGE of you. Its shots are ordinary 1 hit
// point shots that never pierce, marked `drone`: a kill scores the kind's points at x1 for you and
// never touches your streak (combat.ts stepShots). Its effect's one hook point is sim.ts stepArena,
// beside the gun (stepFire). The orbit is a pure function of the tick and the holder's id, so the
// server and every browser agree on where the drone is with nothing on the wire for it.
import { DT, PICKUP_IDS } from "../constants";
import type { ArenaState, Player } from "../sim";
import type { PickupDef } from "./kind";

/** How long the drone lasts, seconds. */
export const DRONE_S = 12;
/** How long it lies on the floor, seconds. */
export const DRONE_FLOOR_S = 12;
/** It fires only at a bug whose centre is within this of the holder's centre, units. */
export const DRONE_RANGE = 400;
/** Shots a second while a bug is in range. */
export const DRONE_FIRE_RATE = 3;
/** The orbit's radius, from the holder's centre, units (release 1's). */
export const DRONE_ORBIT = 34;
/** Radians a second around the orbit (release 1's). */
export const DRONE_SPIN = 3;

export const drone: PickupDef = {
  id: "drone",
  label: "CI drone!",
  // Not dropping yet (#84): every drop set tried for it failed the late-joiner gate (architecture.md
  // "Built so far (#84)"), so how it drops waits on an owner ruling. At 0 it is inert: `bun run
  // skill` prints main's table with the drone's columns at 0.
  drop: { crawler: 0, dasher: 0, spitter: 0, glob: 0 },
  floorTicks: Math.round(DRONE_FLOOR_S / DT),
  durationTicks: Math.round(DRONE_S / DT),
};

const DRONE = PICKUP_IDS.indexOf("drone");
const TAU = Math.PI * 2;
const R2 = DRONE_RANGE * DRONE_RANGE;

/**
 * Where on its orbit player `playerId`'s drone is at tick `tick` (fractional between ticks, as the
 * browser draws), radians in [0, TAU). The id offsets each player's drone, so two do not move in step.
 */
export function droneAngle(tick: number, playerId: number): number {
  return (tick * DT * DRONE_SPIN + playerId) % TAU;
}

/** Whether `p` has the drone now. */
export function hasDrone(p: Player): boolean {
  return p.effect[DRONE]! > 0;
}

/**
 * The effect, one tick, for a player who is up: with the drone, its cooldown runs down, and each
 * time it is owed a shot the drone fires one at the nearest live bug (any kind, globs too) whose
 * centre is within DRONE_RANGE of the holder's, from where the drone is on its orbit this tick,
 * straight at the bug's centre (no lead, no spread, no draw from any generator). With no bug in
 * range the cooldown stops at 0: no shot is banked, so a bug that comes in range gets one shot that
 * tick. Without the drone the cooldown is held at 0. The shot flies its first step in this tick's
 * stepShots, as the gun's do. Allocates nothing but the shot and its event row.
 */
export function stepDrone(state: ArenaState, p: Player): void {
  if (p.effect[DRONE]! <= 0) {
    p.droneCooldown = 0;
    return;
  }
  p.droneCooldown -= DT;
  while (p.droneCooldown <= 0) {
    let target = -1;
    let best = Infinity;
    const bugs = state.bugs;
    // The nearest (ties: the lower index), squared distances only.
    for (let i = 0; i < bugs.length; i++) {
      const b = bugs[i]!;
      if (b.hp <= 0) continue;
      const dx = b.x - p.x;
      const dy = b.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > R2 || d2 >= best) continue;
      best = d2;
      target = i;
    }
    if (target < 0) {
      p.droneCooldown = 0;
      return;
    }
    const b = bugs[target]!;
    const a = droneAngle(state.tick, p.id);
    const x = p.x + Math.cos(a) * DRONE_ORBIT;
    const y = p.y + Math.sin(a) * DRONE_ORBIT;
    // A bug sitting on the drone itself still gets a direction (never NaN on the wire).
    const angle = b.x === x && b.y === y ? a : Math.atan2(b.y - y, b.x - x);
    const id = state.nextShotId++;
    state.shots.push({ id, owner: p.id, life: p.lifeStartTick, x, y, dx: Math.cos(angle), dy: Math.sin(angle), travelled: 0, pierce: 1, laser: false, drone: true, hitA: 0, hitB: 0, hits: 0 });
    state.events.shotsFired.push({ id, owner: p.id, x, y, angle, laser: false, drone: true });
    p.droneCooldown += 1 / DRONE_FIRE_RATE;
  }
}
