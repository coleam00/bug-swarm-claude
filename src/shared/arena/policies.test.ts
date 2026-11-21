// The dasher policy (#60), called directly on a hand-built observation: it dashes only when ready
// and a bug is about to touch it, and then away from the bug. The fill bot (#66): its reaction,
// its wobble, and walking to a downed player, on hand-built observations and in a stepped arena.
import { describe, expect, test } from "bun:test";
import { CRAWLER_RADIUS, DOWN_TICKS, PLAYER_RADIUS, WORLD_H, WORLD_W } from "./constants";
import {
  DASH_CONTACT,
  FILL_REACT_MAX_TICKS,
  FILL_REACT_MIN_TICKS,
  FILL_WOBBLE,
  createFillMemory,
  createMemory,
  createObservation,
  dasher,
  fillBot,
  observe,
  setObservedBug,
  type PolicyInput,
} from "./policies";
import { createRng } from "./rng";
import { clampInput } from "./sim";
import { arenaWith, downNow, stepQuiet } from "./testkit";

/** The dasher at (1200, 1200), ready or not, with one still bug `gap` units to its right. */
function decide(gap: number, ready = true): PolicyInput {
  const obs = createObservation();
  obs.world.w = 2400;
  obs.world.h = 2400;
  obs.self.x = 1200;
  obs.self.y = 1200;
  obs.self.alive = true;
  obs.self.dashReady = ready;
  setObservedBug(obs, 0, 1200 + gap, 1200, 0, 0);
  obs.bugCount = 1;
  const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  dasher(obs, createMemory(), createRng(1), out);
  return out;
}

describe("dasher", () => {
  const touching = PLAYER_RADIUS + CRAWLER_RADIUS;

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
      setObservedBug(obs, 0, 1200 + Math.cos(a) * 300, 1200 + Math.sin(a) * 300, 0, 0);
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

  test("it walks to a downed player 250 units off and revives them before they bleed out", () => {
    const { a, ps } = arenaWith([1000, 1200], [1250, 1200]);
    const [bot, hurt] = [ps[0]!, ps[1]!];
    downNow(a, hurt);
    a.bugs.length = 0;
    const obs = createObservation();
    const mem = createFillMemory();
    const rng = createRng(7);
    const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
    let by = 0;
    for (let t = 0; t < DOWN_TICKS && by === 0; t++) {
      observe(a, bot.id, WORLD_W, WORLD_H, obs);
      fillBot(obs, mem, rng, out);
      bot.input = clampInput({ seq: t + 1, ...out });
      stepQuiet(a);
      by = a.events.revives.find((r) => r.id === hurt.id)?.by ?? 0;
    }
    expect(by).toBe(bot.id);
    expect(hurt.down).toBe(false);
  });
});
