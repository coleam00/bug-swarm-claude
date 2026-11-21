// The balance harness: how long runs last, played on the pure simulation with no browser. It
// plays an idle player and a realistic mover (a human with one thumb, not a perfect dodger)
// through each upgrade order, over a set of seeds and both screen shapes. `bun run pacing`
// prints the full table (scripts/pacing.ts); pacing.test.ts asserts the targets on a slice.
// Like the simulation it never reads a clock or Math.random: the mover has its own seeded generator.
import { UPGRADE_IDS, type UpgradeId } from "../../server/rules";
import { arenaForViewport, type Arena } from "./arena";
import { createRng, nextRandom } from "./rng";
import { choose, createState, runResult, step, type Input, type RunResult, type State } from "./sim";

const DT = 1 / 60;
/** Seconds a run may last before it counts as one that did not end. */
export const RUN_CAP = 600;
/** Phone portrait (450x800) and a desktop (759x474). */
export const SHAPES: readonly Arena[] = [arenaForViewport(390, 844), arenaForViewport(1280, 800)];

/** What the balance aims for (PRD Phase 2, issue #18). */
export const TARGETS = {
  /** An idle player loses before this, on every run. */
  idleMax: 60,
  /** The realistic mover's median over every order, seed and shape. */
  overallMedian: [75, 120] as const,
  /** Each upgrade order's median: no trap build, no build that holds too long. */
  orderMedian: [55, 150] as const,
  /** No run lasts beyond this, with any build. */
  runMax: 240,
};

type Player = (s: State) => Input;
type Picker = (s: State) => number;

const NONE: Input = { kind: "none" };
const idle: Player = () => NONE;

/** Steps behind the swarm the mover steers on: about 0.25 s of reaction time. */
const DELAY = 15;
/** How far the mover sees a bug coming. */
const SEE = 200;
/** How hard it drifts back to the centre, at the arena's edge. */
const CENTRE_PULL = 0.6;
/** How much its thumb wobbles. */
const WOBBLE = 0.25;

/**
 * A realistic mover: steers away from the bugs it saw within SEE units DELAY steps ago, drifts
 * back to the centre, and wobbles a little. Its own generator, seeded from the run's seed.
 */
export function mover(seed: number): Player {
  const rng = createRng((seed * 7919 + 13) | 0);
  const history: number[][] = [];
  let wob = nextRandom(rng) * Math.PI * 2;
  let wobV = 0;
  return (s) => {
    const snap: number[] = [];
    for (const b of s.bugs) snap.push(b.x, b.y);
    history.push(snap);
    if (history.length > DELAY + 1) history.shift();
    const seen = history[0]!;
    const { x, y } = s.robot;
    const { w, h } = s.arena;
    let fx = 0;
    let fy = 0;
    for (let i = 0; i < seen.length; i += 2) {
      const dx = x - seen[i]!;
      const dy = y - seen[i + 1]!;
      const d = Math.hypot(dx, dy) || 1;
      if (d > SEE) continue;
      const k = ((SEE - d) / SEE) ** 2 / d;
      fx += dx * k;
      fy += dy * k;
    }
    fx += ((w / 2 - x) / (w / 2)) * CENTRE_PULL;
    fy += ((h / 2 - y) / (h / 2)) * CENTRE_PULL;
    wobV += (nextRandom(rng) - 0.5) * 0.6;
    wobV *= 0.95;
    wob += wobV * 0.1;
    fx += Math.cos(wob) * WOBBLE;
    fy += Math.sin(wob) * WOBBLE;
    return { kind: "direction", dx: fx, dy: fy };
  };
}

/** `<id>`-first: take it while it is on offer and not yet taken, else the card at the lowest level. */
function first(id: UpgradeId): Picker {
  return (s) => {
    const cards = s.choice!;
    const i = cards.indexOf(id);
    if (i >= 0 && !s.taken.includes(id)) return i;
    let best = 0;
    for (let j = 1; j < cards.length; j++) if (s.levels[cards[j]!] < s.levels[cards[best]!]) best = j;
    return best;
  };
}

/** Always the same one: `id` whenever it is on offer, else the first card. */
function same(id: UpgradeId): Picker {
  return (s) => Math.max(0, s.choice!.indexOf(id));
}

/** The upgrade orders the mover plays, by name. */
export const ORDERS: ReadonlyArray<{ name: string; pick: Picker }> = [
  ...UPGRADE_IDS.map((id) => ({ name: `${id}-first`, pick: first(id) })),
  ...UPGRADE_IDS.map((id) => ({ name: `same-${id}`, pick: same(id) })),
];

/** Plays one run to its end (or RUN_CAP) and returns its finish, as the game would submit it. */
export function play(seed: number, arena: Arena, input: Player, pick: Picker): RunResult {
  const s = createState(seed, arena);
  while (!s.over && s.time < RUN_CAP) {
    step(s, input(s), DT);
    if (s.choice) choose(s, pick(s));
  }
  return runResult(s, false);
}

/** One run of the matrix: its group ("idle" or an order's name), seed, screen shape and finish. */
export type Run = { group: string; seed: number; shape: number; result: RunResult };

/** The whole matrix over `seeds`: the idle player, then the mover through every order, on both shapes. */
export function playAll(seeds: number[]): Run[] {
  const runs: Run[] = [];
  const groups = [{ name: "idle", pick: (() => 0) as Picker, input: () => idle }, ...ORDERS.map((o) => ({ ...o, input: mover }))];
  for (const g of groups) {
    for (const seed of seeds) {
      SHAPES.forEach((arena, shape) => runs.push({ group: g.name, seed, shape, result: play(seed, arena, g.input(seed), g.pick) }));
    }
  }
  return runs;
}

export type Stats = { median: number; p10: number; p90: number; max: number; unfinished: number };

/**
 * Median (the mean of the middle two for an even count), nearest-rank 10th and 90th
 * percentiles, the longest run, and how many runs reached RUN_CAP.
 */
export function stats(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length;
  const at = (q: number) => v[Math.round(q * (n - 1))]!;
  const median = n % 2 ? v[(n - 1) / 2]! : (v[n / 2 - 1]! + v[n / 2]!) / 2;
  return { median, p10: at(0.1), p90: at(0.9), max: v[n - 1]!, unfinished: v.filter((t) => t >= RUN_CAP - 1e-9).length };
}

export type Pacing = {
  idle: Stats;
  orders: Record<string, Stats>;
  overall: Stats;
  targets: { label: string; ok: boolean }[];
};

/** Plays every group over `seeds` and both shapes (or takes `runs`, already played), and checks the targets. */
export function pacing(seeds: number[], runs: Run[] = playAll(seeds)): Pacing {
  const idleTimes: number[] = [];
  const all: number[] = [];
  const orders: Record<string, Stats> = {};
  for (const r of runs) if (r.group === "idle") idleTimes.push(r.result.seconds);
  for (const order of ORDERS) {
    const times = runs.filter((r) => r.group === order.name).map((r) => r.result.seconds);
    orders[order.name] = stats(times);
    all.push(...times);
  }
  const idleStats = stats(idleTimes);
  const overall = stats(all);
  const medians = Object.values(orders).map((o) => o.median);
  const [lo, hi] = TARGETS.overallMedian;
  const [orderLo, orderHi] = TARGETS.orderMedian;
  return {
    idle: idleStats,
    orders,
    overall,
    targets: [
      { label: `idle loses within ${TARGETS.idleMax} s on every run`, ok: idleStats.max < TARGETS.idleMax && idleStats.unfinished === 0 },
      { label: `mover's overall median is ${lo}-${hi} s`, ok: overall.median >= lo && overall.median <= hi },
      { label: `every order's median is ${orderLo}-${orderHi} s`, ok: medians.every((m) => m >= orderLo && m <= orderHi) },
      { label: `no run lasts beyond ${TARGETS.runMax} s`, ok: overall.max <= TARGETS.runMax && idleStats.max <= TARGETS.runMax },
    ],
  };
}

/**
 * What the server's plausibility caps are measured from (MAX_SQUASHES_PER_SECOND and
 * MAX_RUN_SECONDS in rules.ts): the run with the most squashes per second of run time, and the
 * longest run, over every run played.
 */
export function squashRates(runs: Run[]): { maxRate: number; maxRateRun: Run; longest: Run } {
  let maxRate = 0;
  let maxRateRun = runs[0]!;
  let longest = runs[0]!;
  for (const r of runs) {
    const { squashes, seconds } = r.result;
    if (seconds > 0 && squashes / seconds > maxRate) {
      maxRate = squashes / seconds;
      maxRateRun = r;
    }
    if (seconds > longest.result.seconds) longest = r;
  }
  return { maxRate, maxRateRun, longest };
}
