// `bun run skill`'s pure half: plays lives in-process on the real arena simulation and checks the
// three skill gates (PRD.md, "Skill is measured"): the aimer's median score at least 2x the mover's
// (one life per policy per seed, alone); aiming late joiners living at least 0.8x as long as early
// ones (the mover's ratio is reported, not gated); and an idle newcomer living at least 10 s at
// every arena age (newcomers joining seeded arenas that aimer bots have played in). Tested in
// skill-lib.test.ts on a few seeds.
import { DT, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createRng, type Rng } from "../src/shared/arena/rng";
import {
  POLICIES,
  POLICY_NAMES,
  createMemory,
  createObservation,
  observe,
  type Observation,
  type PolicyInput,
  type PolicyMemory,
  type PolicyName,
} from "../src/shared/arena/policies";
import { clampInput, createArena, joinPlayer, stepArena, type ArenaState } from "../src/shared/arena/sim";

export type LifeResult = { score: number; kills: number; seconds: number; capped: boolean };

/** The aimer's median score must be at least this many times the mover's. */
export const GATE_RATIO = 2;

/** The gate: the aimer's median score is above 0 and at least GATE_RATIO times the mover's. */
export function gatePasses(aimerMedian: number, moverMedian: number): boolean {
  return aimerMedian > 0 && aimerMedian >= GATE_RATIO * moverMedian;
}

/**
 * Plays one life of `policy` alone in a fresh arena seeded `seed`, stepping until the life ends or
 * `maxSeconds` pass (then it is reported capped). The policy gets its own generator, never the arena's.
 */
export function playLife(policy: PolicyName, seed: number, maxSeconds: number): LifeResult {
  const state = createArena(seed);
  const p = joinPlayer(state, "skill", "tabs");
  const rng = createRng(seed ^ 0x5bd1e995);
  const mem = createMemory();
  const obs = createObservation();
  const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  const act = POLICIES[policy];
  const maxTicks = Math.round(maxSeconds / DT);
  let seq = 0;
  for (let t = 0; t < maxTicks; t++) {
    observe(state, p.id, WORLD_W, WORLD_H, obs);
    act(obs, mem, rng, out);
    p.input = clampInput({ seq: ++seq, mx: out.mx, my: out.my, aim: out.aim, fire: out.fire, dash: false });
    stepArena(state);
    const ended = state.events.livesEnded[0];
    if (ended) return { score: ended.score, kills: ended.kills, seconds: ended.ticks * DT, capped: false };
  }
  return { score: p.score, kills: p.kills, seconds: (state.tick - p.lifeStartTick) * DT, capped: true };
}

/** The value at fraction `q` (0 to 1) of sorted numbers, interpolated. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

export type PolicySummary = {
  policy: PolicyName;
  lives: number;
  medianScore: number;
  p25Score: number;
  p75Score: number;
  medianSeconds: number;
  p25Seconds: number;
  p75Seconds: number;
  medianKills: number;
  capped: number;
};

export type SkillReport = {
  seeds: number;
  maxSeconds: number;
  policies: PolicySummary[];
  /** aimer median / mover median (Infinity when the mover's is 0). */
  ratio: number;
  pass: boolean;
  /** Set when the gate passed only because the mover scored nothing. */
  trivial: boolean;
};

export function summarize(policy: PolicyName, lives: LifeResult[]): PolicySummary {
  const scores = lives.map((l) => l.score).sort((a, b) => a - b);
  const secs = lives.map((l) => l.seconds).sort((a, b) => a - b);
  const kills = lives.map((l) => l.kills).sort((a, b) => a - b);
  return {
    policy,
    lives: lives.length,
    medianScore: quantile(scores, 0.5),
    p25Score: quantile(scores, 0.25),
    p75Score: quantile(scores, 0.75),
    medianSeconds: quantile(secs, 0.5),
    p25Seconds: quantile(secs, 0.25),
    p75Seconds: quantile(secs, 0.75),
    medianKills: quantile(kills, 0.5),
    capped: lives.filter((l) => l.capped).length,
  };
}

/** The gate's verdict on a set of policy summaries: the aimer's median against the mover's. */
export function judge(policies: readonly Pick<PolicySummary, "policy" | "medianScore">[]): Pick<SkillReport, "ratio" | "pass" | "trivial"> {
  const by = (n: PolicyName) => policies.find((p) => p.policy === n)!;
  const aim = by("aimer").medianScore;
  const move = by("mover").medianScore;
  const ratio = move > 0 ? aim / move : aim > 0 ? Infinity : 0;
  return { ratio, pass: gatePasses(aim, move), trivial: move === 0 && aim > 0 };
}

/** Plays every policy on seeds 0 to seeds-1 and checks the gate. */
export function runSkill(seeds: number, maxSeconds: number): SkillReport {
  const policies = POLICY_NAMES.map((name) => {
    const lives: LifeResult[] = [];
    for (let s = 0; s < seeds; s++) lives.push(playLife(name, s, maxSeconds));
    return summarize(name, lives);
  });
  return { seeds, maxSeconds, policies, ...judge(policies) };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);

export function formatSkill(r: SkillReport): string[] {
  const lines = [
    `skill: ${r.seeds} seeds, one life each, capped at ${r.maxSeconds} s`,
    `${"policy".padEnd(8)}${pad("score p25", 11)}${pad("median", 8)}${pad("p75", 7)}${pad("kills", 7)}${pad("life p25", 10)}${pad("median", 8)}${pad("p75", 7)}${pad("capped", 8)}`,
  ];
  for (const p of r.policies) {
    lines.push(
      `${p.policy.padEnd(8)}${pad(Math.round(p.p25Score), 11)}${pad(Math.round(p.medianScore), 8)}${pad(Math.round(p.p75Score), 7)}${pad(Math.round(p.medianKills), 7)}${pad(p.p25Seconds.toFixed(1), 10)}${pad(p.medianSeconds.toFixed(1), 8)}${pad(p.p75Seconds.toFixed(1), 7)}${pad(p.capped, 8)}`,
    );
  }
  const ratio = Number.isFinite(r.ratio) ? `${r.ratio.toFixed(2)}x` : "infinite";
  lines.push(`gate: aimer median score >= ${GATE_RATIO}x mover: ${ratio} ${r.pass ? "PASS" : "FAIL"}`);
  if (r.trivial) lines.push("note: the mover's median score is 0, so the gate is met trivially; it measured nothing");
  return lines;
}

// ---- Fair drop-in (#58): newcomers joining an arena others have played in for a while. ----

/** A late joiner's median life must be at least this fraction of an early joiner's. */
export const LATE_RATIO = 0.8;
/** An idle newcomer's median life must be at least this long, seconds, at every join age. */
export const IDLE_MIN_S = 10;
/** The arena ages a newcomer joins at, minutes. The late gate compares LATE_AGE_MIN with 0. */
export const JOIN_AGES_MIN = [0, 5, 10, 20] as const;
export const LATE_AGE_MIN = 10;
/** The background: aimer bots that join the arena at tick 0 (PRD.md tops arenas up to 4). */
export const BACKGROUND_BOTS = 3;
/**
 * The policies the late gate gates (owner ruling, 2026-11-21): the aimer. The mover's late ratio is
 * measured and printed but not gated: an early mover lives long only because the fresh aimer bots
 * beside it clear its bugs, which says nothing about pacing (that is proven tick for tick in
 * bugs.test.ts). Re-measure once fill bots and revive land.
 */
export const LATE_POLICIES = ["aimer"] as const satisfies readonly PolicyName[];
/** Policies whose late ratio is reported alongside the gate, not gated. */
export const LATE_REPORTED = ["mover"] as const satisfies readonly PolicyName[];
/** Seeds the late gate plays by default: more than the other gates, so its median is not noise. */
export const LATE_SEEDS = 60;

/** The late gate: a late joiner's median life is at least LATE_RATIO of an early joiner's (above 0). */
export function lateGate(late: number, early: number): boolean {
  return early > 0 && late >= LATE_RATIO * early;
}

/** The idle gate: every join age's median life is at least IDLE_MIN_S. */
export function idleGate(medians: readonly number[]): boolean {
  return medians.length > 0 && medians.every((m) => m >= IDLE_MIN_S);
}

type Bot = { id: number; rng: Rng; mem: PolicyMemory; obs: Observation; out: PolicyInput; seq: number };

/** An arena at some age with its background bots: plain data, so structuredClone replays it exactly. */
export type AgedArena = { ageMin: number; state: ArenaState; bots: Bot[] };

/** One tick of input for a player playing `policy` (dash as the policy says, so a bot respawns). */
function drive(state: ArenaState, bot: Bot, act: (typeof POLICIES)[PolicyName], respawn: boolean): void {
  const p = state.players.find((q) => q.id === bot.id);
  if (!p) return;
  observe(state, bot.id, WORLD_W, WORLD_H, bot.obs);
  act(bot.obs, bot.mem, bot.rng, bot.out);
  const o = bot.out;
  p.input = clampInput({ seq: ++bot.seq, mx: o.mx, my: o.my, aim: o.aim, fire: o.fire, dash: respawn && o.dash });
}

function newBot(id: number, rngSeed: number): Bot {
  return {
    id,
    rng: createRng(rngSeed),
    mem: createMemory(),
    obs: createObservation(),
    out: { mx: 0, my: 0, aim: 0, fire: false, dash: false },
    seq: 0,
  };
}

/**
 * Plays an arena seeded `seed` with BACKGROUND_BOTS aimer bots (generators `seed * 7 + i`) that
 * join at tick 0 and respawn, and returns a copy of it at each age in `agesMin` (ascending).
 */
export function warmArenas(seed: number, agesMin: readonly number[]): AgedArena[] {
  const state = createArena(seed);
  const bots: Bot[] = [];
  for (let i = 0; i < BACKGROUND_BOTS; i++) bots.push(newBot(joinPlayer(state, `bot ${i}`, i % 2 ? "spaces" : "tabs").id, seed * 7 + i));
  const out: AgedArena[] = [];
  for (const ageMin of agesMin) {
    const until = Math.round((ageMin * 60) / DT);
    while (state.tick < until) {
      for (const b of bots) drive(state, b, POLICIES.aimer, true);
      stepArena(state);
    }
    out.push(structuredClone({ ageMin, state, bots }));
  }
  return out;
}

/**
 * Joins a newcomer playing `policy` into a copy of `aged` and steps it with the bots until the
 * newcomer's first life ends or `maxSeconds` pass (reported capped). `aged` itself is untouched.
 */
export function playNewcomer(aged: AgedArena, policy: PolicyName, seed: number, maxSeconds: number): LifeResult {
  const { state, bots } = structuredClone(aged);
  const p = joinPlayer(state, "newcomer", "tabs");
  const me = newBot(p.id, seed ^ 0x5bd1e995);
  const act = POLICIES[policy];
  const maxTicks = Math.round(maxSeconds / DT);
  for (let t = 0; t < maxTicks; t++) {
    for (const b of bots) drive(state, b, POLICIES.aimer, true);
    drive(state, me, act, false);
    stepArena(state);
    for (const ended of state.events.livesEnded) {
      if (ended.id === p.id) return { score: ended.score, kills: ended.kills, seconds: ended.ticks * DT, capped: false };
    }
  }
  return { score: p.score, kills: p.kills, seconds: (state.tick - p.lifeStartTick) * DT, capped: true };
}

/** Life lengths at one join age: median, quartiles, how many hit the cap, and bugs alive at the join (median). */
export type AgeSummary = { ageMin: number; lives: number; median: number; p25: number; p75: number; capped: number; bugsAtJoin: number };

function summarizeAge(ageMin: number, lives: readonly LifeResult[], bugs: readonly number[]): AgeSummary {
  const secs = lives.map((l) => l.seconds).sort((a, b) => a - b);
  return {
    ageMin,
    lives: lives.length,
    median: quantile(secs, 0.5),
    p25: quantile(secs, 0.25),
    p75: quantile(secs, 0.75),
    capped: lives.filter((l) => l.capped).length,
    bugsAtJoin: quantile([...bugs].sort((a, b) => a - b), 0.5),
  };
}

/** One policy's late ratio. `gated` false: reported only, and `pass` does not count. */
export type LateRow = { policy: PolicyName; gated: boolean; early: AgeSummary; late: AgeSummary; ratio: number; pass: boolean };

export type DropInReport = {
  /** Seeds of the idle gate. */
  seeds: number;
  /** Seeds of the late gate. */
  lateSeeds: number;
  maxSeconds: number;
  late: LateRow[];
  latePass: boolean;
  idle: AgeSummary[];
  idlePass: boolean;
};

/**
 * The drop-in gates: each seed's arena is warmed once to the oldest age it needs, and newcomers
 * join copies of it. Idle, on seeds 0 to seeds-1: the idle policy at every age in `agesMin`.
 * Late, on seeds 0 to lateSeeds-1: each LATE_POLICIES (gated) and LATE_REPORTED (reported) policy
 * at `lateAgeMin` against 0.
 */
export function runDropIn(
  seeds: number,
  lateSeeds: number,
  maxSeconds: number,
  agesMin: readonly number[] = JOIN_AGES_MIN,
  lateAgeMin: number = LATE_AGE_MIN,
): DropInReport {
  const lives = new Map<string, LifeResult[]>();
  const bugs = new Map<number, number[]>();
  const add = (k: string, r: LifeResult) => {
    const l = lives.get(k);
    if (l) l.push(r);
    else lives.set(k, [r]);
  };
  const latePolicies: readonly PolicyName[] = [...LATE_REPORTED, ...LATE_POLICIES];
  const lateAges = [0, lateAgeMin];
  for (let s = 0; s < Math.max(seeds, lateSeeds); s++) {
    const idleHere = s < seeds;
    const ages = idleHere ? [...new Set([...agesMin, ...lateAges])].sort((a, b) => a - b) : lateAges;
    for (const aged of warmArenas(s, ages)) {
      const b = bugs.get(aged.ageMin) ?? [];
      b.push(aged.state.bugs.length);
      bugs.set(aged.ageMin, b);
      if (idleHere && agesMin.includes(aged.ageMin)) add(`idle@${aged.ageMin}`, playNewcomer(aged, "idle", s, maxSeconds));
      if (s < lateSeeds && lateAges.includes(aged.ageMin)) {
        for (const pol of latePolicies) add(`${pol}@${aged.ageMin}`, playNewcomer(aged, pol, s, maxSeconds));
      }
    }
  }
  const at = (k: string, age: number) => summarizeAge(age, lives.get(`${k}@${age}`) ?? [], bugs.get(age) ?? []);
  const late = latePolicies.map((policy): LateRow => {
    const early = at(policy, 0);
    const lateS = at(policy, lateAgeMin);
    const gated = (LATE_POLICIES as readonly PolicyName[]).includes(policy);
    return { policy, gated, early, late: lateS, ratio: early.median > 0 ? lateS.median / early.median : 0, pass: lateGate(lateS.median, early.median) };
  });
  const idle = agesMin.map((age) => at("idle", age));
  const gated = late.filter((r) => r.gated);
  return {
    seeds,
    lateSeeds,
    maxSeconds,
    late,
    latePass: gated.length > 0 && gated.every((r) => r.pass),
    idle,
    idlePass: idleGate(idle.map((r) => r.median)),
  };
}

export function formatDropIn(r: DropInReport): string[] {
  const lines = [
    `drop-in: ${BACKGROUND_BOTS} aimer bots from tick 0, newcomer's first life, capped at ${r.maxSeconds} s; late on ${r.lateSeeds} seeds, idle on ${r.seeds}`,
    `${"late".padEnd(8)}${pad("join", 6)}${pad("bugs", 6)}${pad("life p25", 10)}${pad("median", 8)}${pad("p75", 7)}${pad("capped", 8)}`,
  ];
  const row = (label: string, a: AgeSummary) =>
    `${label.padEnd(8)}${pad(`${a.ageMin}m`, 6)}${pad(Math.round(a.bugsAtJoin), 6)}${pad(a.p25.toFixed(1), 10)}${pad(a.median.toFixed(1), 8)}${pad(a.p75.toFixed(1), 7)}${pad(a.capped, 8)}`;
  for (const l of r.late) {
    lines.push(row(l.policy, l.early));
    lines.push(row(l.policy, l.late));
  }
  for (const l of r.late) {
    const verdict = l.gated ? (l.pass ? "PASS" : "FAIL") : "(reported, not gated)";
    lines.push(`${l.gated ? "gate" : "info"}: ${l.policy} late (${l.late.ageMin}m) median life >= ${LATE_RATIO}x early (0m): ${l.ratio.toFixed(2)}x ${verdict}`);
  }
  lines.push(`${"idle".padEnd(8)}${pad("join", 6)}${pad("bugs", 6)}${pad("life p25", 10)}${pad("median", 8)}${pad("p75", 7)}${pad("capped", 8)}`);
  for (const a of r.idle) lines.push(row("idle", a));
  const worst = Math.min(...r.idle.map((a) => a.median));
  lines.push(`gate: idle newcomer median life >= ${IDLE_MIN_S} s at every join age: lowest ${worst.toFixed(1)} s ${r.idlePass ? "PASS" : "FAIL"}`);
  return lines;
}

export type SkillArgs = { seeds: number; lateSeeds: number; max: number };

export const USAGE = `usage: bun run skill [--seeds 30] [--late-seeds ${LATE_SEEDS}] [--max 300]`;

export function parseSkillArgs(argv: readonly string[]): SkillArgs | string {
  const args: SkillArgs = { seeds: 30, lateSeeds: LATE_SEEDS, max: 300 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = Number(argv[i + 1]);
    if (flag === "--seeds" && Number.isInteger(v) && v >= 1) args.seeds = v;
    else if (flag === "--late-seeds" && Number.isInteger(v) && v >= 1) args.lateSeeds = v;
    else if (flag === "--max" && Number.isFinite(v) && v > 0) args.max = v;
    else return USAGE;
    i++;
  }
  return args;
}
