// `bun run skill`'s pure half: plays one life per policy per seed in-process, on the real arena
// simulation, and checks the skill gate (PRD.md, "Skill is measured"): the aimer's median score
// at least 2x the mover's. Tested in skill-lib.test.ts on a few seeds.
import { DT, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createRng } from "../src/shared/arena/rng";
import { POLICIES, POLICY_NAMES, createMemory, createObservation, observe, type PolicyInput, type PolicyName } from "../src/shared/arena/policies";
import { clampInput, createArena, joinPlayer, stepArena } from "../src/shared/arena/sim";

export type LifeResult = { score: number; kills: number; seconds: number; capped: boolean };

/** The aimer's median score must be at least this many times the mover's. */
export const GATE_RATIO = 2;

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

/** Plays every policy on seeds 0 to seeds-1 and checks the gate. */
export function runSkill(seeds: number, maxSeconds: number): SkillReport {
  const policies = POLICY_NAMES.map((name) => {
    const lives: LifeResult[] = [];
    for (let s = 0; s < seeds; s++) lives.push(playLife(name, s, maxSeconds));
    return summarize(name, lives);
  });
  const by = (n: PolicyName) => policies.find((p) => p.policy === n)!;
  const aim = by("aimer").medianScore;
  const move = by("mover").medianScore;
  const ratio = move > 0 ? aim / move : aim > 0 ? Infinity : 0;
  return { seeds, maxSeconds, policies, ratio, pass: ratio >= GATE_RATIO, trivial: move === 0 && aim > 0 };
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

export type SkillArgs = { seeds: number; max: number };

export const USAGE = "usage: bun run skill [--seeds 30] [--max 300]";

export function parseSkillArgs(argv: readonly string[]): SkillArgs | string {
  const args: SkillArgs = { seeds: 30, max: 300 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = Number(argv[i + 1]);
    if (flag === "--seeds" && Number.isInteger(v) && v >= 1) args.seeds = v;
    else if (flag === "--max" && Number.isFinite(v) && v > 0) args.max = v;
    else return USAGE;
    i++;
  }
  return args;
}
