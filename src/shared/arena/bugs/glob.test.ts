// A spitter's glob (#72), by stepping: it flies straight, fades and is gone at 2.5 s, a wall ends
// it, a shot downs it, it costs a hit on contact, it never comes from the spawn mix, and the caps
// on globs and on bugs hold at a launch. Also the seam it rides (bugs/index.ts): a launched bug
// is not stepped in its launch tick but can touch in it, and an expired one leaves untouched.
import { describe, expect, test } from "bun:test";
import { DT, MAX_BUGS_PER_ARENA, WAVE_S, WORLD_W } from "../constants";
import { createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Kill } from "../sim";
import { arenaWith, hold, placeBug, stepQuiet } from "../testkit";
import { FADE, FADE_TICKS, FLY, FLY_TICKS, GLOB_MAX_PER_ARENA, GLOB_SPEED } from "./glob";
import { bugDef } from "./registry";
import { MUZZLE, SPIT, TELL, TELL_TICKS } from "./spitter";

const GLOB = "glob" as const;
/** The item's numbers: fades after 2.5 s, one shot, 5 points. */
const ITEM_LIFE_S = 2.5;

/** A glob at (x, y) flying along (dx, dy), as a launch leaves it. */
function placeGlob(a: ArenaState, x: number, y: number, dx: number, dy: number): Bug {
  const g = placeBug(a, x, y, GLOB);
  g.dx = dx;
  g.dy = dy;
  g.vx = dx * GLOB_SPEED;
  g.vy = dy * GLOB_SPEED;
  return g;
}

function aboutToSpit(a: ArenaState, x: number, y: number): Bug {
  const s = placeBug(a, x, y, "spitter");
  s.phase = TELL;
  s.phaseTicks = TELL_TICKS - 1;
  return s;
}

describe("glob flight", () => {
  test("it flies straight along its line at 15 units a step, whoever is near", () => {
    const { a, ps } = arenaWith([1200, 1500]);
    ps[0]!.invulnTicks = 1e9;
    const g = placeGlob(a, 1000, 1200, 1, 0);
    for (let n = 1; n <= 10; n++) {
      stepQuiet(a);
      expect(g.x).toBeCloseTo(1000 + n * GLOB_SPEED * DT, 9);
      expect(g.y).toBe(1200);
    }
    expect(GLOB_SPEED * DT).toBe(15);
  });

  test("it fades for its last 0.5 s and is gone at 2.5 s, with no kill, touch or score", () => {
    expect((FLY_TICKS + FADE_TICKS) * DT).toBeCloseTo(ITEM_LIFE_S, 9);
    const { a, ps } = arenaWith([200, 200]);
    const g = placeGlob(a, 600, 1200, 1, 0);
    let events = 0;
    for (let n = 1; n <= FLY_TICKS + FADE_TICKS; n++) {
      stepQuiet(a);
      events += a.events.kills.length + a.events.touches.length;
      if (n < FLY_TICKS) expect(g.phase).toBe(FLY);
      else if (n < FLY_TICKS + FADE_TICKS) expect([g.phase, a.bugs.includes(g)]).toEqual([FADE, true]);
    }
    expect(a.bugs).not.toContain(g);
    expect([events, ps[0]!.score, ps[0]!.hits]).toEqual([0, 0, 0]);
  });

  test("a wall ends it on the step it would leave the floor", () => {
    const { a } = arenaWith([200, 200]);
    const g = placeGlob(a, WORLD_W - 20, 1200, 1, 0);
    stepQuiet(a);
    expect(a.bugs).not.toContain(g);
    expect(a.events.kills).toEqual([]);
  });
});

describe("glob contact and shots", () => {
  test("touching a player costs a hit and spends the glob", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const g = placeGlob(a, 1300, 1200, -1, 0);
    for (let n = 0; n < 10 && a.bugs.includes(g); n++) stepQuiet(a);
    expect(a.bugs).not.toContain(g);
    expect(a.events.touches).toEqual([{ player: p.id, kind: GLOB }]);
    expect(p.hits).toBe(1);
  });

  test("one shot downs it for 5 (times the multiplier), growing the streak", () => {
    expect([bugDef(GLOB).hp, bugDef(GLOB).points]).toEqual([1, 5]);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    // Flying away along the aim: the shot (45 a step) catches it.
    const g = placeGlob(a, 1290, 1200, 1, 0);
    const kills: Kill[] = [];
    for (let n = 0; n < 20 && kills.length === 0; n++) {
      hold(p, { fire: n === 0 });
      stepQuiet(a);
      kills.push(...a.events.kills);
    }
    expect(kills).toEqual([expect.objectContaining({ bug: g.id, by: p.id, points: 5, kind: GLOB })]);
    expect([p.kills, p.streak, p.score]).toEqual([1, 1, 5]);
    expect(a.bugs).not.toContain(g);
  });
});

describe("glob launches and caps", () => {
  test("a glob launched onto a player touches in its launch step, before it has flown", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    // The mouth is MUZZLE along the aim: 30 - MUZZLE from the player, inside the touch distance.
    aboutToSpit(a, 1230, 1200);
    const before = a.nextBugId;
    stepQuiet(a);
    expect(a.nextBugId).toBe(before + 1);
    expect(a.events.touches).toEqual([{ player: p.id, kind: GLOB }]);
    expect(30 - MUZZLE).toBeLessThan(14 + 8);
  });

  test("with the arena's glob cap in flight, a spitter's tell ends in its recoil and lobs nothing", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    for (let i = 0; i < GLOB_MAX_PER_ARENA; i++) placeGlob(a, 300, 300 + i * 40, 0, 1).phaseTicks = 0;
    const s = aboutToSpit(a, 1500, 1200);
    stepQuiet(a);
    expect(s.phase).toBe(SPIT);
    expect(a.bugs.filter((b) => b.kind === GLOB)).toHaveLength(GLOB_MAX_PER_ARENA);
    // One fewer in flight, and the next spit lobs.
    a.bugs.splice(a.bugs.findIndex((b) => b.kind === GLOB), 1);
    s.phase = TELL;
    s.phaseTicks = TELL_TICKS - 1;
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === GLOB)).toHaveLength(GLOB_MAX_PER_ARENA);
  });

  test("with the arena full of bugs, a launch adds none", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    const s = aboutToSpit(a, 1500, 1200);
    while (a.bugs.length < MAX_BUGS_PER_ARENA) placeBug(a, 100, 100).target = 0;
    stepQuiet(a);
    expect(s.phase).toBe(SPIT);
    expect(a.bugs.length).toBe(MAX_BUGS_PER_ARENA);
    expect(a.bugs.some((b) => b.kind === GLOB)).toBe(false);
  });

  test("the spawn mix never makes a glob", () => {
    const a = createArena(11);
    a.tick = Math.round((6 * WAVE_S) / DT);
    joinPlayer(a, "a", "tabs").lifeStartTick = a.tick - Math.round(300 / DT);
    let all = 0;
    let globs = 0;
    for (let t = 0; t < 60 / DT; t++) {
      const before = a.nextBugId;
      for (const p of a.players) p.invulnTicks = 1e9;
      stepArena(a);
      for (const b of a.bugs) {
        if (b.id < before) continue;
        all++;
        if (b.kind === GLOB) globs++;
      }
      // Cleared every step: no spitter lives to spit, so any glob would be the mix's.
      a.bugs.length = 0;
    }
    expect(all).toBeGreaterThan(400);
    expect(globs).toBe(0);
  });
});
