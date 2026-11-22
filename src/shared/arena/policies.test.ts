// The dasher policy (#60), called directly on a hand-built observation: it dashes only when ready
// and a bug is about to touch it, and then away from the bug. The fill bot (#66): its reaction,
// its wobble, and walking to a downed player, on hand-built observations and in a stepped arena.
// Going for pickups (#73): the aimer and the dasher do, the fill bot does not.
import { describe, expect, test } from "bun:test";
import { MAX_BUG_RADIUS } from "./bugs/registry";
import { DOWN_TICKS, DT, PLAYER_RADIUS, WORLD_H, WORLD_W } from "./constants";
import {
  DASH_CONTACT,
  FILL_REACT_MAX_TICKS,
  FILL_REACT_MIN_TICKS,
  FILL_WOBBLE,
  KEEP_DIST,
  PICKUP_SEEK,
  aimer,
  aimerBase,
  createFillMemory,
  createMemory,
  createObservation,
  dasher,
  fillBot,
  observe,
  setObservedBug,
  setObservedPickup,
  type FillMemory,
  type Observation,
  type Policy,
  type PolicyInput,
} from "./policies";
import { createRng, type Rng } from "./rng";
import { clampInput } from "./sim";
import { arenaWith, downNow, placeBug, placePickup, stepQuiet } from "./testkit";

/** The dasher at (1200, 1200), ready or not, with one still bug `gap` units to its right. */
function decide(gap: number, ready = true): PolicyInput {
  const obs = createObservation();
  obs.world.w = 2400;
  obs.world.h = 2400;
  obs.self.x = 1200;
  obs.self.y = 1200;
  obs.self.alive = true;
  obs.self.dashReady = ready;
  setObservedBug(obs, 0, 1200 + gap, 1200, 0, 0, 0, 0);
  obs.bugCount = 1;
  const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  dasher(obs, createMemory(), createRng(1), out);
  return out;
}

describe("dasher", () => {
  const touching = PLAYER_RADIUS + MAX_BUG_RADIUS;

  test("a bug about to touch it: it dashes, away from the bug", () => {
    const out = decide(touching + DASH_CONTACT - 5);
    expect(out.dash).toBe(true);
    expect(out.mx).toBeLessThan(-0.9);
  });

  test("a bug farther off: no dash", () => {
    expect(decide(touching + DASH_CONTACT + 60).dash).toBe(false);
  });

  test("its dash not ready: no dash, however close the bug", () => {
    expect(decide(touching + 5, false).dash).toBe(false);
  });
});

describe("fill bot", () => {
  /** A fill bot at (1200, 1200) with one still bug 300 units off at `angle`; returns its decision each tick. */
  function play(seed: number, angles: number[]): PolicyInput[] {
    const obs = createObservation();
    obs.world.w = 2400;
    obs.world.h = 2400;
    obs.self.x = 1200;
    obs.self.y = 1200;
    obs.self.alive = true;
    obs.bugCount = 1;
    const mem = createFillMemory();
    const rng = createRng(seed);
    return angles.map((a) => {
      setObservedBug(obs, 0, 1200 + Math.cos(a) * 300, 1200 + Math.sin(a) * 300, 0, 0, 0, 0);
      const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
      fillBot(obs, mem, rng, out);
      return out;
    });
  }
  const settle = Array<number>(40).fill(0);

  test("a new target is reacted to late: fire held for 4 to 6 ticks; the same seed decides the same", () => {
    const held = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const outs = play(seed, [...settle, ...Array<number>(20).fill(0.7)]);
      expect(outs[settle.length - 1]!.fire).toBe(true);
      const after = outs.slice(settle.length);
      const firstFire = after.findIndex((o) => o.fire);
      expect(firstFire).toBeGreaterThanOrEqual(FILL_REACT_MIN_TICKS);
      expect(firstFire).toBeLessThanOrEqual(FILL_REACT_MAX_TICKS);
      held.add(firstFire);
      expect(play(seed, [...settle, 0.7, 0.7])).toEqual(outs.slice(0, settle.length + 2));
    }
    expect(held.size).toBeGreaterThan(1);
  });

  test("once settled on a target, its aim wobbles within FILL_WOBBLE of the aimer's", () => {
    const outs = play(3, Array<number>(200).fill(0)).slice(20);
    for (const o of outs) expect(Math.abs(o.aim)).toBeLessThanOrEqual(FILL_WOBBLE + 1e-9);
    expect(outs.some((o) => o.aim !== 0)).toBe(true);
  });

  test("observe lists the other players who are down, not yourself", () => {
    const { a, ps } = arenaWith([1000, 1000], [1250, 1000], [1600, 1600]);
    downNow(a, ps[1]!);
    const obs = observe(a, ps[0]!.id, WORLD_W, WORLD_H, createObservation());
    expect(obs.downCount).toBe(1);
    expect(obs.downs[0]).toEqual({ x: ps[1]!.x, y: ps[1]!.y });
    expect(observe(a, ps[1]!.id, WORLD_W, WORLD_H, createObservation()).downCount).toBe(0);
  });

  /**
   * A fill bot at (1000, 1200) and a player downed `gap` units to its right, with crawlers placed
   * at `bugs` (they chase the bot; nothing else spawns). Steps until the downed player is revived
   * or bleeds out; returns who revived them (0: nobody), the closest any bug came to the bot, and
   * the farthest the bot ever was from the downed player.
   */
  function reviveRun(bugs: [number, number][], seed: number, gap = 250): { by: number; bot: number; closest: number; farthest: number } {
    const { a, ps } = arenaWith([1000, 1200], [1000 + gap, 1200]);
    const [bot, hurt] = [ps[0]!, ps[1]!];
    downNow(a, hurt);
    a.bugs.length = 0;
    for (const [x, y] of bugs) placeBug(a, x, y);
    const obs = createObservation();
    const mem = createFillMemory();
    const rng = createRng(seed);
    const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    let by = 0;
    let closest = Infinity;
    let farthest = 0;
    for (let t = 0; t < DOWN_TICKS && by === 0; t++) {
      for (const b of a.bugs) closest = Math.min(closest, Math.hypot(b.x - bot.x, b.y - bot.y));
      observe(a, bot.id, WORLD_W, WORLD_H, obs);
      fillBot(obs, mem, rng, out);
      bot.input = clampInput({ seq: t + 1, ...out });
      stepQuiet(a);
      by = a.events.revives.find((r) => r.id === hurt.id)?.by ?? 0;
      farthest = Math.max(farthest, Math.hypot(bot.x - hurt.x, bot.y - hurt.y));
    }
    return { by, bot: bot.id, closest, farthest };
  }

  test("it walks to a downed player 250 units off and revives them before they bleed out", () => {
    const r = reviveRun([], 7);
    expect(r.by).toBe(r.bot);
  });

  test("beside a downed player, it stands still through a swarm closing in and completes the revive", () => {
    // 12 crawlers in a half ring behind the bot, 200 to 240 units out: inside KEEP_DIST, so the
    // aimer underneath wants to run from them the whole time.
    const swarm: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      const angle = Math.PI / 2 + (i / 12) * Math.PI;
      const r = i % 2 ? 200 : 240;
      swarm.push([1000 + Math.cos(angle) * r, 1200 + Math.sin(angle) * r]);
    }
    for (let seed = 1; seed <= 8; seed++) {
      const r = reviveRun(swarm, seed, 30);
      expect(r.closest).toBeLessThan(KEEP_DIST);
      // It never moved: still 30 units off when the revive completed.
      expect([seed, r.by, Math.round(r.farthest)]).toEqual([seed, r.bot, 30]);
    }
  });

  test("it breaks off to revive in a live swarm: 30 crawlers chasing it from inside KEEP_DIST", () => {
    // A half ring behind the bot (away from the downed player), 150 and 250 units out.
    const swarm: [number, number][] = [];
    for (let i = 0; i < 30; i++) {
      const angle = Math.PI / 2 + (i / 30) * Math.PI;
      const r = i % 2 ? 150 : 250;
      swarm.push([1000 + Math.cos(angle) * r, 1200 + Math.sin(angle) * r]);
    }
    for (let seed = 1; seed <= 8; seed++) {
      const r = reviveRun(swarm, seed);
      expect(r.closest).toBeLessThan(KEEP_DIST);
      expect([seed, r.by]).toEqual([seed, r.bot]);
    }
  });
});

describe("going for pickups (#73)", () => {
  /** A policy at (1200, 1200) with a pickup 200 units right and, if given, a still bug `bugGap` units up. */
  function decidePickup(policy: Policy | ((o: Observation, m: FillMemory, r: Rng, out: PolicyInput) => void), bugGap: number | null): PolicyInput {
    const obs = createObservation();
    obs.world.w = 2400;
    obs.world.h = 2400;
    obs.self.x = 1200;
    obs.self.y = 1200;
    obs.self.alive = true;
    setObservedPickup(obs, 0, 1400, 1200);
    obs.pickupCount = 1;
    if (bugGap !== null) {
      setObservedBug(obs, 0, 1200, 1200 - bugGap, 0, 0, 0, 0);
      obs.bugCount = 1;
    }
    const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    policy(obs, createFillMemory(), createRng(1), out);
    return out;
  }

  test("the aimer walks at full speed to a pickup 200 units off with no bug near, aim and fire unchanged", () => {
    const out = decidePickup(aimer, 500);
    expect(out.mx).toBeCloseTo(1, 9);
    expect(out.my).toBeCloseTo(0, 9);
    const base = decidePickup(aimerBase, 500);
    expect([out.aim, out.fire]).toEqual([base.aim, base.fire]);
    expect(decidePickup(dasher, null).mx).toBeCloseTo(1, 9);
  });

  test("with a bug inside KEEP_DIST it evades instead; past PICKUP_SEEK it ignores the pickup", () => {
    const out = decidePickup(aimer, KEEP_DIST - 20);
    // Evading straight down, away from the bug above.
    expect(out.my).toBeGreaterThan(0.9);
    const obs = createObservation();
    obs.world.w = 2400;
    obs.world.h = 2400;
    obs.self.x = 1200;
    obs.self.y = 1200;
    obs.self.alive = true;
    setObservedPickup(obs, 0, 1200 + PICKUP_SEEK + 1, 1200);
    obs.pickupCount = 1;
    const far: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    aimer(obs, createMemory(), createRng(1), far);
    expect(Math.abs(far.mx)).toBeLessThan(0.5);
  });

  test("the fill bot does not go for pickups", () => {
    expect(decidePickup(fillBot, 500).mx).not.toBeCloseTo(1, 2);
    const fill = decidePickup(fillBot, null);
    const base = decidePickup(aimerBase, null);
    expect([fill.mx, fill.my]).toEqual([base.mx, base.my]);
  });

  test("observe sees the floor's pickups", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    placePickup(a, 1500, 1300, "shield");
    placePickup(a, 900, 1000, "laser");
    const obs = observe(a, ps[0]!.id, WORLD_W, WORLD_H, createObservation());
    expect(obs.pickupCount).toBe(2);
    expect(obs.pickups.slice(0, 2)).toEqual([
      { x: 1500, y: 1300 },
      { x: 900, y: 1000 },
    ]);
  });
});

describe("flanking a beetle (#80)", () => {
  /**
   * One aimer at (1200, 1200), untouchable, its life 300 s old (a beetle stands at a life under
   * 60 s, #86), and a beetle 300 units off at `angle`, walking and facing it; nothing spawns.
   * Steps up to 20 s; `blind` zeroes every bug's shell facing in the aimer's observation, an
   * aimer that does not know about shells. Returns when the beetle died (seconds, -1: alive at
   * 20 s) and the aimer's shots that hurt it and that its shell blocked.
   */
  function duel(angle: number, seed: number, blind: boolean): { killedAt: number; hits: number; blocks: number } {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.invulnTicks = 1e9;
    p.firstLife = false;
    p.lifeStartTick = a.tick - Math.round(300 / DT);
    const b = placeBug(a, 1200 + Math.cos(angle) * 300, 1200 + Math.sin(angle) * 300, "beetle");
    b.phase = 1;
    b.dx = -Math.cos(angle);
    b.dy = -Math.sin(angle);
    const obs = createObservation();
    const mem = createMemory();
    const rng = createRng(seed);
    const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    let hits = 0;
    let blocks = 0;
    for (let t = 0; t < 20 / DT; t++) {
      observe(a, p.id, WORLD_W, WORLD_H, obs);
      if (blind) for (const o of obs.bugs) o.fx = o.fy = 0;
      aimer(obs, mem, rng, out);
      p.input = clampInput({ seq: t + 1, ...out });
      stepQuiet(a);
      blocks += a.events.shellBlocks.length;
      hits += a.events.shotsEnded.filter((e) => e.hit && !e.blocked).length;
      if (!a.bugs.includes(b)) return { killedAt: (t + 1) * DT, hits, blocks };
    }
    return { killedAt: -1, hits, blocks };
  }

  test("the aimer walks round a beetle that faces it and kills it from the side, its shots almost never blocked", () => {
    for (const [angle, seed] of [
      [0, 1],
      [1, 2],
      [2.5, 3],
      [4, 4],
    ] as const) {
      const r = duel(angle, seed, false);
      expect(r.killedAt).toBeGreaterThan(0);
      expect(r.killedAt).toBeLessThan(10);
      expect(r.blocks).toBeLessThanOrEqual(2);
    }
  });

  test("flanking a beetle 100 units off, a crawler behind it does not push it into the beetle", () => {
    // The beetle 100 units right, facing it; a crawler 280 units left. Inside FLANK_NEAR the beetle
    // repels it as a threat, so its move is away from the beetle, not toward it.
    const obs = createObservation();
    obs.world.w = 2400;
    obs.world.h = 2400;
    obs.self.x = 1200;
    obs.self.y = 1200;
    obs.self.alive = true;
    setObservedBug(obs, 0, 1300, 1200, 0, 0, -1, 0);
    setObservedBug(obs, 1, 920, 1200, 0, 0, 0, 0);
    obs.bugCount = 2;
    const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    aimerBase(obs, createMemory(), createRng(1), out);
    expect(out.mx).toBeLessThan(0);
    // It does not shoot the shell: it aims at the crawler.
    expect(Math.abs(out.aim)).toBeCloseTo(Math.PI, 1);
  });

  test("observe sees a beetle's shell facing, and no facing on a bug without a shell", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const beetle = placeBug(a, 1500, 1200, "beetle");
    beetle.phase = 1;
    beetle.dx = 0;
    beetle.dy = 1;
    const dasher = placeBug(a, 900, 1200, "dasher");
    dasher.dx = 1;
    const obs = observe(a, ps[0]!.id, WORLD_W, WORLD_H, createObservation());
    expect([obs.bugs[0]!.fx, obs.bugs[0]!.fy]).toEqual([0, 1]);
    expect([obs.bugs[1]!.fx, obs.bugs[1]!.fy]).toEqual([0, 0]);
  });
});
