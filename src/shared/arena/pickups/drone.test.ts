// The CI drone by stepping (#84): for 12 s it orbits its holder and fires 3 shots a second at the
// nearest live bug within 400 units of them; its kills score x1 for the holder and never touch the streak.
import { describe, expect, test } from "bun:test";
import { WALK } from "../bugs/beetle";
import { bugDef } from "../bugs/registry";
import { mult } from "../combat";
import { DT, PICKUP_IDS } from "../constants";
import { nextRandom } from "../rng";
import { endLife, type ArenaState, type Bug, type Player } from "../sim";
import { arenaWith, downNow, effectOf, hold, nextDrop, placeBug, placePickup, stepQuiet } from "../testkit";
import { DRONE_FIRE_RATE, DRONE_ORBIT, DRONE_RANGE, DRONE_S, drone, droneAngle, stepDrone } from "./drone";

const DRONE = PICKUP_IDS.indexOf("drone");
const LASER = PICKUP_IDS.indexOf("laser");

/** The drone's shots fired in the last step. */
function droneShots(a: ArenaState) {
  return a.events.shotsFired.filter((f) => f.drone);
}

/** A player at (1200, 1200) holding the drone (set directly, as a take sets it). */
function withDrone() {
  const { a, ps } = arenaWith([1200, 1200]);
  const p = ps[0]!;
  p.effect[DRONE] = drone.durationTicks;
  return { a, p };
}

/** Holds `b` where it is with plenty of hit points, and `p` untouchable, for one step. */
function pin(p: Player, b: Bug, x: number, y: number): void {
  b.x = x;
  b.y = y;
  b.hp = 1000;
  p.invulnTicks = 100;
}

describe("the CI drone", () => {
  test("is taken like any pickup: its effect and HUD timer show 12 s (240 ticks), and it lapses at 0", () => {
    expect(DRONE_S).toBe(12);
    expect(drone.durationTicks).toBe(240);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    placePickup(a, 1200, 1200, "drone");
    stepQuiet(a);
    expect(a.events.pickups).toEqual([{ player: p.id, kind: "drone" }]);
    expect(effectOf(p, "drone")).toBe(240);
    stepQuiet(a, 239);
    expect(effectOf(p, "drone")).toBe(1);
    stepQuiet(a);
    expect(effectOf(p, "drone")).toBe(0);
    // Lapsed: a bug well in range draws no drone shot.
    placeBug(a, 1400, 1200);
    stepQuiet(a);
    expect(droneShots(a)).toEqual([]);
  });

  test("it fires from where it is on its orbit this tick, the angle every browser draws it at", () => {
    const { a, p } = withDrone();
    placeBug(a, 1500, 1200);
    stepQuiet(a);
    const [f] = droneShots(a);
    // The step ran at tick a.tick - 1; the snapshot that reports the shot carries a.tick, and a
    // shot reported at tick T is drawn leaving its origin at drawing time T - 1 (combat.ts shotTravelAt).
    const ang = droneAngle(a.tick - 1, p.id);
    expect(f!.x).toBeCloseTo(1200 + Math.cos(ang) * DRONE_ORBIT, 9);
    expect(f!.y).toBeCloseTo(1200 + Math.sin(ang) * DRONE_ORBIT, 9);
    expect(f!.owner).toBe(p.id);
    expect(f!.laser).toBe(false);
    // Two players' drones are not in step.
    expect(droneAngle(10, 1)).not.toBe(droneAngle(10, 2));
  });

  test("it targets the nearest live bug, straight at its centre", () => {
    const { a, p } = withDrone();
    placeBug(a, 1200, 1500); // 300 away
    const near = placeBug(a, 1000, 1200); // 200 away
    const dead = placeBug(a, 1250, 1200);
    dead.hp = 0;
    stepDrone(a, p);
    const [f] = droneShots(a);
    expect(f!.angle).toBeCloseTo(Math.atan2(near.y - f!.y, near.x - f!.x), 12);
    expect(a.shots[0]!.dx).toBeCloseTo(Math.cos(f!.angle), 12);
  });

  test("its range is the item's 400 units from the holder's centre: 399 is shot, 401 never", () => {
    expect(DRONE_RANGE).toBe(400);
    const { a, p } = withDrone();
    // stepDrone alone, so no bug walks into range between the checks.
    const far = placeBug(a, 1200 + 401, 1200);
    for (let i = 0; i < 40; i++) stepDrone(a, p);
    expect(a.shots).toEqual([]);
    expect(p.droneCooldown).toBe(0);
    far.x = 1200 + 399;
    stepDrone(a, p);
    expect(a.shots.length).toBe(1);
  });

  test("it fires 3 shots a second: 36 over its 240 ticks with a bug always in range, then no more", () => {
    expect(DRONE_FIRE_RATE).toBe(3);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const b = placeBug(a, 1500, 1200);
    placePickup(a, 1200, 1200, "drone");
    let shots = 0;
    for (let i = 0; i < 260; i++) {
      pin(p, b, 1500, 1200);
      stepQuiet(a);
      shots += droneShots(a).length;
    }
    // Taken in the first step (after shots), so it fires from the second: one shot at once, then
    // one each 1/3 s (6.67 ticks) for 240 ticks: at ticks 0, 7, 14, 20, ... 234, 239 of the effect.
    expect(shots).toBe(36);
    expect(240 * DT * DRONE_FIRE_RATE).toBe(36);
    expect(p.alive && !p.down).toBe(true);
    expect(effectOf(p, "drone")).toBe(0);
  });

  test("with no bug in range it banks no shots: a bug coming in range after 2 s gets one shot that tick", () => {
    const { a, p } = withDrone();
    stepQuiet(a, 40);
    expect(p.droneCooldown).toBe(0);
    placeBug(a, 1500, 1200);
    stepQuiet(a);
    expect(droneShots(a).length).toBe(1);
    stepQuiet(a);
    expect(droneShots(a).length).toBe(0);
  });

  test("its kills score the kind's points at x1 for the holder, count in kills, and leave the streak alone", () => {
    const { a, p } = withDrone();
    p.streak = 10;
    p.score = 100;
    p.kills = 3;
    expect(mult(10)).toBe(2);
    placeBug(a, 1400, 1200);
    let droneKills: number[] = [];
    for (let i = 0; i < 10 && droneKills.length === 0; i++) {
      stepQuiet(a);
      droneKills = [...a.events.droneKills];
    }
    expect(droneKills).toEqual([p.id]);
    expect(a.events.kills.map((k) => [k.by, k.points])).toEqual([[p.id, bugDef("crawler").points]]);
    expect(p.score).toBe(100 + bugDef("crawler").points);
    expect([p.kills, p.streak]).toEqual([4, 10]);
  });

  test("a drone shot that flies out of range having hit nothing leaves the streak alone", () => {
    const { a, p } = withDrone();
    p.streak = 7;
    placeBug(a, 1500, 1200);
    stepQuiet(a);
    expect(droneShots(a).length).toBe(1);
    // The target leaves; the shot flies on to its range.
    a.bugs.length = 0;
    let missed = false;
    for (let i = 0; i < 30 && !missed; i++) {
      stepQuiet(a);
      missed = a.events.shotsEnded.some((e) => !e.hit);
    }
    expect(missed).toBe(true);
    expect(p.streak).toBe(7);
  });

  test("a drone shot off a beetle's shell (#80) leaves the streak alone too", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.streak = 7;
    // A beetle 300 units right, its shell facing the shooter; a drone shot flying straight at it.
    const b = placeBug(a, 1500, 1200, "beetle");
    b.phase = WALK;
    b.dx = -1;
    b.dy = 0;
    const hp = b.hp;
    a.shots.push({ id: a.nextShotId++, owner: p.id, life: p.lifeStartTick, x: b.x - 40, y: b.y, dx: 1, dy: 0, travelled: 0, pierce: 1, laser: false, drone: true, hitA: 0, hitB: 0, hits: 0 });
    stepQuiet(a);
    expect(a.events.shotsEnded.map((e) => e.blocked)).toEqual([true]);
    expect(b.hp).toBe(hp);
    expect(p.streak).toBe(7);
  });

  test("its shots never pierce, even while the holder has the review laser", () => {
    const { a, p } = withDrone();
    p.effect[LASER] = 80;
    placeBug(a, 1400, 1200);
    stepDrone(a, p);
    expect(a.shots.map((s) => [s.pierce, s.laser, s.drone])).toEqual([[1, false, true]]);
  });

  test("it never draws from the arena's generator: spawns and gun spread replay as without it", () => {
    const run = (withIt: boolean) => {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      if (withIt) p.effect[DRONE] = drone.durationTicks;
      const b = placeBug(a, 1500, 1200);
      for (let i = 0; i < 60; i++) {
        // The gun fires away from the bug, drawing its spread every shot.
        hold(p, { aim: Math.PI, fire: i % 10 < 4 });
        pin(p, b, 1500, 1200);
        stepQuiet(a);
      }
      return { rng: a.rng.state, gun: a.shots.filter((s) => !s.drone).length };
    };
    const off = run(false);
    expect(run(true)).toEqual(off);
    expect(nextRandom({ state: off.rng })).toBe(nextRandom({ state: run(true).rng }));
  });

  test("a downed holder's drone never fires", () => {
    const { a, p } = withDrone();
    downNow(a, p);
    expect(p.down).toBe(true);
    // Going down clears effects; set it again to show the step itself skips a holder who is down.
    p.effect[DRONE] = 100;
    a.bugs.length = 0;
    placeBug(a, 1500, 1200);
    stepQuiet(a);
    expect(droneShots(a)).toEqual([]);
  });

  test("a drone shot whose holder's life ended scores nothing", () => {
    const { a, p } = withDrone();
    placeBug(a, 1290, 1200);
    stepDrone(a, p);
    a.events.shotsFired.length = 0;
    endLife(a, p);
    const kills: [number, number][] = [];
    for (let i = 0; i < 5 && kills.length === 0; i++) {
      stepQuiet(a);
      kills.push(...a.events.kills.map((k): [number, number] => [k.by, k.points]));
      expect(a.events.droneKills).toEqual([]);
    }
    expect(kills).toEqual([[0, 0]]);
  });

  test("its kills draw their drops like any shot kill", () => {
    const { a } = withDrone();
    placeBug(a, 1400, 1200);
    nextDrop(a, 0.5, true);
    const rng = { state: a.dropRng.state };
    nextRandom(rng);
    for (let i = 0; i < 10 && a.events.droneKills.length === 0; i++) stepQuiet(a);
    // The kill drew exactly one number (a miss: at least 0.5), as a gun kill does.
    expect(a.events.droneKills.length).toBe(1);
    expect(a.dropRng.state).toBe(rng.state);
  });
});
