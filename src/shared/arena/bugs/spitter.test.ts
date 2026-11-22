// The spitter (#72), by stepping the arena with hand-placed players and bugs: it keeps its range,
// tells before every glob, leads a moving target, and its spawn rules and kill.
import { describe, expect, test } from "bun:test";
import { DT, MAX_SPEED, WAVE_S } from "../constants";
import { createArena, joinPlayer, stepArena, type ArenaState, type Bug, type Kill, type Player } from "../sim";
import { arenaWith, downNow, hold, placeBug, stepQuiet } from "../testkit";
import { GLOB_SPEED } from "./glob";
import { bugDef } from "./registry";
import {
  KEEP,
  KEEP_FAR,
  KEEP_NEAR,
  MUZZLE,
  RELOAD_TICKS,
  SPIT,
  SPITTER_SHARE_MAX,
  SPIT_TICKS,
  TELL,
  TELL_TICKS,
  leadAim,
  spitterShare,
} from "./spitter";

const SPITTER = "spitter" as const;
const GLOB = "glob" as const;

/** The item's numbers, written out so a test fails if a constant drifts from them. */
const ITEM_TELL_TICKS = 16; // 0.8 s
const ITEM_GLOB_SPEED = 300;
/** The owner's ruled cap on spitters per arena (#72). */
const OWNER_SPITTER_CAP = 6;

const globs = (a: ArenaState) => a.bugs.filter((b) => b.kind === GLOB);

/** Makes `p`'s life `seconds` old in pressure age (not a first life, so nothing is held back). */
function aged(a: ArenaState, p: Player, seconds: number): void {
  p.firstLife = false;
  p.lifeStartTick = a.tick - Math.round(seconds / DT);
}

/** A spitter at the end of its tell, `gap` units right of (x, y): its next step launches. */
function aboutToSpit(a: ArenaState, x: number, y: number): Bug {
  const s = placeBug(a, x, y, SPITTER);
  s.phase = TELL;
  s.phaseTicks = TELL_TICKS - 1;
  return s;
}

describe("spitter range", () => {
  for (const gap of [700, 150]) {
    test(`placed ${gap} units from a still player, it reaches its ${KEEP_NEAR} to ${KEEP_FAR} band and holds it, strafing`, () => {
      const { a, ps } = arenaWith([1200, 1200]);
      const p = ps[0]!;
      p.invulnTicks = 1e9; // its globs pass through, so only its range is measured
      const s = placeBug(a, 1200 + gap, 1200, SPITTER);
      const d = () => Math.hypot(s.x - p.x, s.y - p.y);
      for (let n = 0; n < 100 && (d() < KEEP_NEAR || d() > KEEP_FAR); n++) stepQuiet(a);
      expect(d()).toBeGreaterThanOrEqual(KEEP_NEAR);
      expect(d()).toBeLessThanOrEqual(KEEP_FAR);
      let walked = 0;
      for (let n = 0; n < 200; n++) {
        const [x, y] = [s.x, s.y];
        stepQuiet(a);
        walked += Math.hypot(s.x - x, s.y - y);
        expect(d()).toBeGreaterThanOrEqual(KEEP_NEAR - 1e-6);
        expect(d()).toBeLessThanOrEqual(KEEP_FAR + 1e-6);
      }
      // It strafed round the player between its spits rather than standing.
      expect(walked).toBeGreaterThan(200);
    });
  }

  test("a wall turns its strafe back, and it stays inside the walls", () => {
    const { a, ps } = arenaWith([1200, 100]);
    ps[0]!.invulnTicks = 1e9;
    const s = placeBug(a, 1200, 60, SPITTER);
    s.x = 1200 + 300;
    s.y = 20;
    s.travel = 1; // strafing toward the top wall
    let turned = false;
    for (let n = 0; n < 200; n++) {
      stepQuiet(a);
      if (s.travel === -1) turned = true;
      expect(s.y).toBeGreaterThanOrEqual(bugDef(SPITTER).radius);
    }
    expect(turned).toBe(true);
  });
});

describe("spitter tell and spit", () => {
  test("every glob comes after exactly 16 steps of tell, then the recoil, over 600 steps", () => {
    expect(TELL_TICKS).toBe(ITEM_TELL_TICKS);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.invulnTicks = 1e9;
    aged(a, p, 120);
    const s = placeBug(a, 1500, 1200, SPITTER);
    const phases: number[] = [];
    const seen = new Set<number>();
    let launches = 0;
    for (let n = 0; n < 600; n++) {
      // The player walks a slow square, so the spitter's aim keeps changing.
      hold(p, { mx: Math.cos(n / 40) * 0.5, my: Math.sin(n / 40) * 0.5 });
      p.invulnTicks = 1e9;
      stepQuiet(a);
      phases.push(s.phase);
      for (const g of globs(a)) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        launches++;
        // Launched this step, which ended its tell: the 16 steps before were all tell, the one before them keep.
        expect(s.phase).toBe(SPIT);
        const before = phases.slice(-1 - TELL_TICKS, -1);
        expect(before).toEqual(Array(TELL_TICKS).fill(TELL));
        expect(phases[phases.length - 2 - TELL_TICKS]).toBe(KEEP);
      }
    }
    // A glob every RELOAD + TELL + SPIT steps or so: 600 steps give several.
    expect(launches).toBeGreaterThanOrEqual(Math.floor(600 / (RELOAD_TICKS + TELL_TICKS + SPIT_TICKS)) - 1);
    // Never a tell cut short: every run of tell steps is exactly 16 long.
    const runs = phases.join("").split(/[^1]+/).filter((r) => r.length > 0);
    for (const r of runs.slice(0, -1)) expect(r.length).toBe(TELL_TICKS);
  });

  test("it stands still through its tell and its recoil, then keeps its distance again", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    const s = aboutToSpit(a, 1500, 1200);
    s.phaseTicks = 0;
    for (let n = 0; n < TELL_TICKS - 1; n++) {
      stepQuiet(a);
      expect([s.phase, s.x, s.y, s.vx, s.vy]).toEqual([TELL, 1500, 1200, 0, 0]);
    }
    stepQuiet(a);
    expect(s.phase).toBe(SPIT);
    for (let n = 0; n < SPIT_TICKS - 1; n++) {
      stepQuiet(a);
      expect([s.phase, s.x, s.y]).toEqual([SPIT, 1500, 1200]);
    }
    stepQuiet(a);
    expect([s.phase, s.phaseTicks]).toEqual([KEEP, 0]);
  });

  test("it does not tell before RELOAD_TICKS in keep, counted from its spawn", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    aged(a, ps[0]!, 120);
    const s = placeBug(a, 1500, 1200, SPITTER);
    let first = -1;
    for (let n = 0; n < RELOAD_TICKS + 5 && first < 0; n++) {
      stepQuiet(a);
      if (s.phase === TELL) first = n;
    }
    expect(first).toBe(RELOAD_TICKS);
  });

  test("with no one up at the end of its tell, it lobs nothing and keeps its distance again", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    downNow(a, ps[0]!);
    const s = aboutToSpit(a, 1500, 1200);
    stepQuiet(a);
    expect(globs(a)).toEqual([]);
    expect([s.phase, s.phaseTicks]).toEqual([KEEP, 0]);
  });

  test("the glob leaves its mouth along its aim at 300 u/s, and flies from the next step", () => {
    expect(GLOB_SPEED).toBe(ITEM_GLOB_SPEED);
    const { a, ps } = arenaWith([1200, 1200]);
    ps[0]!.invulnTicks = 1e9;
    aboutToSpit(a, 1500, 1200);
    stepQuiet(a);
    const [g] = globs(a);
    expect(g).toBeDefined();
    expect([g!.x, g!.y, g!.dx, g!.dy, g!.vx, g!.vy, g!.phase]).toEqual([1500 - MUZZLE, 1200, -1, 0, -GLOB_SPEED, 0, 0]);
    stepQuiet(a);
    expect(g!.x).toBeCloseTo(1500 - MUZZLE - GLOB_SPEED * DT, 9);
  });
});

describe("spitter spares young lives (owner ruling)", () => {
  /** Steps a spitter beside `p` for `ticks`; returns how many steps it spent telling and how many globs it lobbed. */
  function watch(a: ArenaState, p: Player, ticks: number): { tells: number; launches: number } {
    p.invulnTicks = 1e9;
    const s = placeBug(a, p.x + 300, p.y, SPITTER);
    let tells = 0;
    let launches = 0;
    for (let n = 0; n < ticks; n++) {
      const before = a.nextBugId;
      stepQuiet(a);
      if (s.phase === TELL) tells++;
      launches += a.nextBugId - before;
    }
    return { tells, launches };
  }

  test("a first life's 10 s hold-back counts: at 65 s old it is 55 s of pressure age, and spared", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.lifeStartTick = a.tick - Math.round(65 / DT);
    expect(p.firstLife).toBe(true);
    expect(watch(a, p, Math.round(4 / DT)).launches).toBe(0);
  });

  test("a spitter between a young life and an old one, nearer the young, holds fire until the young life comes of age", () => {
    const { a, ps } = arenaWith([1200, 1200], [1200, 1900]);
    const [young, old] = [ps[0]!, ps[1]!];
    aged(a, young, 40);
    aged(a, old, 300);
    young.invulnTicks = 1e9;
    old.invulnTicks = 1e9;
    const s = placeBug(a, 1200, 1500, SPITTER);
    let firstTell = -1;
    for (let n = 0; n < Math.round(30 / DT) && firstTell < 0; n++) {
      stepQuiet(a);
      if (s.phase === TELL) firstTell = n;
    }
    // Its target is the young life (nearer), so it waits for that life's 60th second: about 20 s.
    expect(s.target).toBe(young.id);
    expect(firstTell * DT).toBeGreaterThanOrEqual(20 - DT);
    expect(firstTell * DT).toBeLessThan(21);
  });
});

describe("spitter lead", () => {
  /** A player running down at 200 u/s, 340 units left of a spitter about to spit; returns its hits after the glob's flight. */
  function shoot(): { hits: number; touches: number } {
    const { a, ps } = arenaWith([1200, 1000]);
    const p = ps[0]!;
    // Run up to speed first: two thirds of the stick is 200 u/s.
    for (let n = 0; n < 10; n++) {
      hold(p, { my: 2 / 3 });
      stepQuiet(a);
    }
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(200, 6);
    // Placed so it is 340 to the right of where the player is after this step's move.
    const s = aboutToSpit(a, p.x + 340, p.y + p.vy * DT);
    stepQuiet(a);
    const g = globs(a)[0]!;
    expect(s.phase).toBe(SPIT);
    let touches = 0;
    for (let n = 0; n < 60 && a.bugs.includes(g); n++) {
      stepQuiet(a);
      touches += a.events.touches.filter((t) => t.kind === GLOB).length;
    }
    return { hits: p.hits, touches };
  }

  test("a glob aimed with lead hits a target running across its line", () => {
    const r = shoot();
    expect(r.hits).toBe(1);
    expect(r.touches).toBe(1);
  });

  test("a dashing target's velocity is clamped to a run's before it leads", () => {
    const a = { dx: 0, dy: 0 };
    const b = { dx: 0, dy: 0 };
    leadAim(1500, 1200, 1200, 1200, 0, 1466.7, a);
    leadAim(1500, 1200, 1200, 1200, 0, MAX_SPEED, b);
    expect(a).toEqual(b);
    // And a still target is aimed at straight.
    leadAim(1500, 1200, 1200, 1200, 0, 0, a);
    expect(a).toEqual({ dx: -1, dy: 0 });
  });
});

describe("spitter spawns", () => {
  /** Steps with every player untouchable; calls `onSpawn` for each new bug; `clear` empties the arena after each step. */
  function stepSpawning(a: ArenaState, ticks: number, onSpawn: (b: Bug) => void, clear = false): void {
    for (let t = 0; t < ticks; t++) {
      const before = a.nextBugId;
      for (const p of a.players) p.invulnTicks = 1e9;
      stepArena(a);
      for (const b of a.bugs) if (b.id >= before) onSpawn(b);
      if (clear) a.bugs.length = 0;
    }
  }

  test("waves 1 and 2 spawn no spitter, however old the life", () => {
    const a = createArena(4);
    joinPlayer(a, "a", "tabs").lifeStartTick = -Math.round(200 / DT);
    let n = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round((2 * WAVE_S - 1) / DT),
      (b) => {
        all++;
        if (b.kind === SPITTER) n++;
      },
      true,
    );
    expect(all).toBeGreaterThan(200);
    expect(n).toBe(0);
  });

  test("its share grows from 8% at 60 s to a 20% cap, and holds in play; each spawns with 3 hit points", () => {
    expect(spitterShare(59.9)).toBe(0);
    expect(spitterShare(60)).toBeCloseTo(0.08, 9);
    expect(spitterShare(80)).toBeCloseTo(0.16, 9);
    expect(spitterShare(1000)).toBe(SPITTER_SHARE_MAX);
    const a = createArena(6);
    a.tick = Math.round((5 * WAVE_S) / DT);
    joinPlayer(a, "a", "tabs").lifeStartTick = a.tick - Math.round(200 / DT);
    let n = 0;
    let all = 0;
    stepSpawning(
      a,
      Math.round(60 / DT),
      (b) => {
        all++;
        if (b.kind !== SPITTER) return;
        n++;
        expect(b.hp).toBe(3);
      },
      true,
    );
    expect(all).toBeGreaterThan(400);
    expect(Math.abs(n / all - SPITTER_SHARE_MAX)).toBeLessThan(0.07);
  });

  test("an arena never holds more than its cap of spitters", () => {
    const a = createArena(7);
    a.tick = Math.round((5 * WAVE_S) / DT);
    for (let i = 0; i < 20; i++) joinPlayer(a, `p${i}`, "tabs").lifeStartTick = a.tick - Math.round(300 / DT);
    let most = 0;
    for (let t = 0; t < 20 / DT; t++) {
      stepSpawning(a, 1, () => {});
      most = Math.max(most, a.bugs.filter((b) => b.kind === SPITTER).length);
    }
    expect(most).toBe(OWNER_SPITTER_CAP);
  });
});

describe("spitter kills", () => {
  test("it takes 3 shots and kills for 30 (times the multiplier)", () => {
    expect(bugDef(SPITTER).hp).toBe(3);
    expect(bugDef(SPITTER).points).toBe(30);
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const s = placeBug(a, 1290, 1200, SPITTER);
    const kills: Kill[] = [];
    for (let t = 0; t < 40 && kills.length === 0; t++) {
      hold(p, { fire: t === 0 || t === 6 || t === 12 });
      s.phase = SPIT; // stands still while it is shot
      s.phaseTicks = 0;
      stepQuiet(a);
      kills.push(...a.events.kills);
    }
    expect(kills).toEqual([expect.objectContaining({ bug: s.id, by: p.id, points: 30, kind: SPITTER })]);
    expect([p.kills, p.streak, p.score]).toEqual([1, 3, 30]);
  });
});
