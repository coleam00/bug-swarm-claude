// `bun run skill`'s pure half: plays lives in-process on the real arena simulation and checks the
// three skill gates (PRD.md, "Skill is measured"): the aimer's median score at least 2x the mover's
// (one life per policy per seed, alone); aiming late joiners living at least 0.8x as long as early
// ones (the mover's ratio is reported, not gated); and an idle newcomer living at least 10 s at
// every arena age (newcomers joining seeded arenas that aimer bots have played in). The dasher
// (#60) is printed beside the first gate and against the aimer, not gated; so is the server's fill
// bot (#66), placed between 2x the mover and the aimer. Per bug kind (#65) it also prints how many
// of each spawned in a life and how many hits each landed (the first gate's lives, played alone),
// and per pickup (#73) how many the player took, how many hits a shield blocked, how many bugs
// its review laser shots hit and how many its refactor bombs killed (#78); and for bugs with a
// shell (#80, the beetle), how many the player killed and how many of its shots a shell blocked.
// It reports how long aimers take to kill the wave-5 hive queen (#85, runQueen), not gated.
// Every gate is played with pickups dropping. Tested in skill-lib.test.ts on a few seeds.
import { BUG_KINDS, DASH_TICKS, DT, PICKUP_IDS, WORLD_H, WORLD_W, type BugKind, type PickupId } from "../src/shared/arena/constants";
import { bugDef } from "../src/shared/arena/bugs/registry";
import { createRng, type Rng } from "../src/shared/arena/rng";
import {
  AIMER,
  DASHER,
  POLICIES,
  POLICY_NAMES,
  createFillMemory,
  createMemory,
  createObservation,
  fillBot,
  observe,
  type Observation,
  type PolicyInput,
  type PolicyMemory,
  type PolicyName,
} from "../src/shared/arena/policies";
import { clampInput, createArena, joinPlayer, stepArena, type ArenaState } from "../src/shared/arena/sim";

/** A count per bug kind. */
export type PerKind = Record<BugKind, number>;

function perKind(): PerKind {
  return Object.fromEntries(BUG_KINDS.map((k) => [k, 0])) as PerKind;
}

/** A count per pickup id. */
export type PerPickup = Record<PickupId, number>;

function perPickup(): PerPickup {
  return Object.fromEntries(PICKUP_IDS.map((k) => [k, 0])) as PerPickup;
}

/**
 * One life's pickups (#73): taken in all (#90) and by id, hits its shields blocked (a first life's
 * spawn shield included, #90), bugs its laser shots hit, bugs its bombs killed (#78), bugs its CI
 * drone's shots killed (#84).
 */
export type PickupCounts = { total: number; taken: PerPickup; blocks: number; laserHits: number; bombKills: number; droneKills: number };

function pickupCounts(): PickupCounts {
  return { total: 0, taken: perPickup(), blocks: 0, laserHits: 0, bombKills: 0, droneKills: 0 };
}

/** Adds the last step's pickups for player `id` to `c`. */
function countPickups(state: ArenaState, id: number, c: PickupCounts): void {
  const ev = state.events;
  for (const x of ev.pickups) {
    if (x.player !== id) continue;
    c.total++;
    c.taken[x.kind]++;
  }
  for (const b of ev.blocks) if (b === id) c.blocks++;
  for (const o of ev.laserHits) if (o === id) c.laserHits++;
  for (const o of ev.bombKills) if (o === id) c.bombKills++;
  for (const o of ev.droneKills) if (o === id) c.droneKills++;
}

/** The bug kinds with a shell (#80). */
const SHELLED_KINDS: readonly BugKind[] = BUG_KINDS.filter((k) => bugDef(k).shell !== undefined);

/** One life's shelled bugs (#80): kills of a kind with a shell, and its shots a shell blocked. */
export type ShellCounts = { kills: number; blocks: number };

/** Adds the last step's shelled-bug kills and shell blocks for player `id` to `c`. */
export function countShells(state: ArenaState, id: number, c: ShellCounts): void {
  for (const k of state.events.kills) if (k.by === id && SHELLED_KINDS.includes(k.kind)) c.kills++;
  for (const o of state.events.shellBlocks) if (o === id) c.blocks++;
}

/** One life's result: what the drop-in gates read. */
export type DropInLife = { score: number; kills: number; seconds: number; capped: boolean; dashes: number };

/** One life of the first gate: alone in its arena, so every bug that spawned was for this player. */
export type LifeResult = DropInLife & {
  /** Bugs of each kind that spawned in the arena during the life. */
  spawned: PerKind;
  /** Hits the player took from each kind. */
  touches: PerKind;
  pickups: PickupCounts;
  shells: ShellCounts;
};

/**
 * Adds the last step's bugs to `spawned` by kind (every bug with an id from `firstNew`: those still
 * here, and any shot in the same step; a touch never comes the step a bug spawns, 560 units away)
 * and the hits player `id` took to `touches` by kind.
 */
function countKinds(state: ArenaState, firstNew: number, id: number, spawned: PerKind, touches: PerKind): void {
  for (const b of state.bugs) if (b.id >= firstNew) spawned[b.kind]++;
  for (const k of state.events.kills) if (k.bug >= firstNew) spawned[k.kind]++;
  for (const x of state.events.touches) if (x.player === id) touches[x.kind]++;
}

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
  return playLifeWith(POLICIES[policy], createMemory(), seed, maxSeconds);
}

/** playLife for any policy and its memory (the fill bot keeps more than PolicyMemory). */
function playLifeWith<M extends PolicyMemory>(
  act: (obs: Observation, mem: M, rng: Rng, out: PolicyInput) => void,
  mem: M,
  seed: number,
  maxSeconds: number,
): LifeResult {
  const state = createArena(seed);
  const p = joinPlayer(state, "skill", "tabs");
  const rng = createRng(seed ^ 0x5bd1e995);
  const obs = createObservation();
  const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  const maxTicks = Math.round(maxSeconds / DT);
  let seq = 0;
  let dashes = 0;
  const spawned = perKind();
  const touches = perKind();
  const pickups = pickupCounts();
  const shells: ShellCounts = { kills: 0, blocks: 0 };
  for (let t = 0; t < maxTicks; t++) {
    observe(state, p.id, WORLD_W, WORLD_H, obs);
    act(obs, mem, rng, out);
    p.input = clampInput({ seq: ++seq, mx: out.mx, my: out.my, aim: out.aim, fire: out.fire, dash: out.dash });
    const firstNew = state.nextBugId;
    stepArena(state);
    // A dash the simulation started this tick (not one the policy merely asked for).
    if (p.dashTicks === DASH_TICKS) dashes++;
    countKinds(state, firstNew, p.id, spawned, touches);
    countPickups(state, p.id, pickups);
    countShells(state, p.id, shells);
    const ended = state.events.livesEnded[0];
    if (ended) return { score: ended.score, kills: ended.kills, seconds: ended.ticks * DT, capped: false, dashes, spawned, touches, pickups, shells };
  }
  return { score: p.score, kills: p.kills, seconds: (state.tick - p.lifeStartTick) * DT, capped: true, dashes, spawned, touches, pickups, shells };
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
  /** Dashes per life, median. */
  medianDashes: number;
  capped: number;
  /** Bugs of each kind spawned in a life, median. */
  medianSpawned: PerKind;
  /** Hits taken from each kind in a life, median. */
  medianTouches: PerKind;
  /** Pickups a life (#73): taken by id, shield blocks, laser hits, bomb kills and drone kills, median and mean. */
  pickups: { median: PickupCounts; mean: PickupCounts };
  /** Shelled bugs a life (#80): kills and shots blocked, median and mean. */
  shells: { median: ShellCounts; mean: ShellCounts };
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
  const dashes = lives.map((l) => l.dashes).sort((a, b) => a - b);
  const medianOf = (pick: (l: LifeResult) => PerKind) => {
    const m = perKind();
    for (const k of BUG_KINDS) m[k] = quantile(lives.map((l) => pick(l)[k]).sort((a, b) => a - b), 0.5);
    return m;
  };
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
    medianDashes: quantile(dashes, 0.5),
    capped: lives.filter((l) => l.capped).length,
    medianSpawned: medianOf((l) => l.spawned),
    medianTouches: medianOf((l) => l.touches),
    pickups: pickupStats(lives.map((l) => l.pickups)),
    shells: shellStats(lives.map((l) => l.shells)),
  };
}

/** The median and mean of each shelled-bug count over `lives`. */
export function shellStats(lives: readonly ShellCounts[]): { median: ShellCounts; mean: ShellCounts } {
  const n = Math.max(1, lives.length);
  const of = (pick: (c: ShellCounts) => number) => {
    const v = lives.map(pick).sort((a, b) => a - b);
    return [quantile(v, 0.5), v.reduce((s, x) => s + x, 0) / n] as const;
  };
  const [mk, ak] = of((c) => c.kills);
  const [mb, ab] = of((c) => c.blocks);
  return { median: { kills: mk, blocks: mb }, mean: { kills: ak, blocks: ab } };
}

/** The median and mean of each pickup count over `lives`. */
export function pickupStats(lives: readonly PickupCounts[]): { median: PickupCounts; mean: PickupCounts } {
  const median = pickupCounts();
  const mean = pickupCounts();
  const n = Math.max(1, lives.length);
  const of = (pick: (c: PickupCounts) => number) => {
    const v = lives.map(pick).sort((a, b) => a - b);
    return [quantile(v, 0.5), v.reduce((s, x) => s + x, 0) / n] as const;
  };
  [median.total, mean.total] = of((c) => c.total);
  for (const id of PICKUP_IDS) [median.taken[id], mean.taken[id]] = of((c) => c.taken[id]);
  [median.blocks, mean.blocks] = of((c) => c.blocks);
  [median.laserHits, mean.laserHits] = of((c) => c.laserHits);
  [median.bombKills, mean.bombKills] = of((c) => c.bombKills);
  [median.droneKills, mean.droneKills] = of((c) => c.droneKills);
  return { median, mean };
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

// ---- Fill bots (#66): good but beatable. Reported, not a gate. ----

/** The fill bot's median score, against the aimer's and the mover's from a skill report. */
export type FillReport = { lives: number; medianScore: number; medianSeconds: number; aimer: number; mover: number };

/** Plays one fill-bot life alone on each of seeds 0 to seeds-1 (as playLife does). */
export function runFill(seeds: number, maxSeconds: number, skill: SkillReport): FillReport {
  const lives: LifeResult[] = [];
  for (let s = 0; s < seeds; s++) lives.push(playLifeWith(fillBot, createFillMemory(), s, maxSeconds));
  const by = (n: PolicyName) => skill.policies.find((p) => p.policy === n)?.medianScore ?? 0;
  return {
    lives: lives.length,
    medianScore: quantile(lives.map((l) => l.score).sort((a, b) => a - b), 0.5),
    medianSeconds: quantile(lives.map((l) => l.seconds).sort((a, b) => a - b), 0.5),
    aimer: by(AIMER),
    mover: by("mover"),
  };
}

/** Whether the fill bot sits where it should: above 2x the mover's median score, below the aimer's. */
export function fillBeatable(r: FillReport): boolean {
  return r.medianScore > GATE_RATIO * r.mover && r.medianScore < r.aimer;
}

export function formatFill(r: FillReport): string {
  return `info: fill bot median score ${Math.round(r.medianScore)} (life ${r.medianSeconds.toFixed(1)} s) against aimer ${Math.round(r.aimer)} and ${GATE_RATIO}x mover ${Math.round(GATE_RATIO * r.mover)}: ${fillBeatable(r) ? "between them" : "OUTSIDE"} (reported, not gated)`;
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
  const aim = r.policies.find((p) => p.policy === AIMER);
  const dash = r.policies.find((p) => p.policy === DASHER);
  if (aim && dash && aim.medianScore > 0 && aim.medianSeconds > 0) {
    lines.push(
      `dasher vs aimer: ${(dash.medianScore / aim.medianScore).toFixed(2)}x median score, ${(dash.medianSeconds / aim.medianSeconds).toFixed(2)}x median life, ${dash.medianDashes} dashes a life (median)`,
    );
  }
  lines.push("bug kinds, median a life: spawned / hits landed on the player");
  for (const p of r.policies) {
    lines.push(`${p.policy.padEnd(8)}${BUG_KINDS.map((k) => `${k} ${p.medianSpawned[k]} / ${p.medianTouches[k]}`).join(", ")}`);
  }
  lines.push(
    "pickups a life, median (mean): taken in all and by id, hits blocked by a shield (a first life's spawn shield included), bugs hit by laser shots, bugs killed by bombs and by drones",
  );
  for (const p of r.policies) {
    const { median: m, mean: a } = p.pickups;
    const v = (x: number, y: number) => `${x} (${y.toFixed(1)})`;
    lines.push(
      `${p.policy.padEnd(8)}in all ${v(m.total, a.total)}, ${PICKUP_IDS.map((id) => `${id} ${v(m.taken[id], a.taken[id])}`).join(", ")}, blocks ${v(m.blocks, a.blocks)}, laser hits ${v(m.laserHits, a.laserHits)}, bomb kills ${v(m.bombKills, a.bombKills)}, drone kills ${v(m.droneKills, a.droneKills)}`,
    );
  }
  if (SHELLED_KINDS.length > 0) {
    lines.push(`bugs with a shell (${SHELLED_KINDS.join(", ")}) a life, median (mean): killed, shots the shell blocked`);
    for (const p of r.policies) {
      const { median: m, mean: a } = p.shells;
      lines.push(`${p.policy.padEnd(8)}kills ${m.kills} (${a.kills.toFixed(1)}), blocked ${m.blocks} (${a.blocks.toFixed(1)})`);
    }
  }
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
 * src/shared/arena/bugs/index.test.ts). Fill bots (#66) do not change it: this background stays plain aimer bots.
 */
export const LATE_POLICIES = ["aimer"] as const satisfies readonly PolicyName[];
/** Policies whose late ratio is reported alongside the gate, not gated. */
export const LATE_REPORTED = ["mover"] as const satisfies readonly PolicyName[];
/**
 * Seeds the late gate plays by default: more than the other gates, so its median is not noise.
 * 240 (owner ruling, #72): on 60 the ratio swings by about 0.05 with small changes to bug
 * behaviour, and the gate sits near its floor. `--late-seeds 60` is the quick mode (about 15 s
 * for the whole run, against about a minute), for a first look, not for the gate's verdict.
 */
export const LATE_SEEDS = 240;

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
export function playNewcomer(aged: AgedArena, policy: PolicyName, seed: number, maxSeconds: number): DropInLife {
  const { state, bots } = structuredClone(aged);
  const p = joinPlayer(state, "newcomer", "tabs");
  const me = newBot(p.id, seed ^ 0x5bd1e995);
  const act = POLICIES[policy];
  const maxTicks = Math.round(maxSeconds / DT);
  let dashes = 0;
  for (let t = 0; t < maxTicks; t++) {
    for (const b of bots) drive(state, b, POLICIES.aimer, true);
    drive(state, me, act, false);
    stepArena(state);
    if (p.dashTicks === DASH_TICKS) dashes++;
    for (const ended of state.events.livesEnded) {
      if (ended.id === p.id) return { score: ended.score, kills: ended.kills, seconds: ended.ticks * DT, capped: false, dashes };
    }
  }
  return { score: p.score, kills: p.kills, seconds: (state.tick - p.lifeStartTick) * DT, capped: true, dashes };
}

/** Life lengths at one join age: median, quartiles, how many hit the cap, and bugs alive at the join (median). */
export type AgeSummary = { ageMin: number; lives: number; median: number; p25: number; p75: number; capped: number; bugsAtJoin: number };

function summarizeAge(ageMin: number, lives: readonly DropInLife[], bugs: readonly number[]): AgeSummary {
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
  const lives = new Map<string, DropInLife[]>();
  const bugs = new Map<number, number[]>();
  const add = (k: string, r: DropInLife) => {
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

// ---- The hive queen (#85): how long a group takes to bring her down. Reported, not a gate. ----

/** Seeds the queen report plays, and the people (aimers) it plays them with; a solo row beside it. */
export const QUEEN_SEEDS = 30;
export const QUEEN_AIMERS = 4;
/** The item's target: 4 aimers bring her down in under this, seconds (median). */
export const QUEEN_TARGET_S = 60;
/** A fight still going this long after she arrives is reported capped, seconds. */
export const QUEEN_CAP_S = 180;

export type QueenReport = { seeds: number; aimers: number; median: number; p75: number; capped: number; hp: number };

/**
 * How long `aimers` aimer bots (people, respawning) take to kill the wave-5 hive queen, on seeds 0
 * to seeds-1: each seed's arena is played from tick 0 until she arrives, then until she dies or
 * QUEEN_CAP_S pass (counted as the cap). Also her median hit points at arrival.
 */
export function runQueen(seeds: number, aimers: number): QueenReport {
  const secs: number[] = [];
  const hps: number[] = [];
  let capped = 0;
  for (let seed = 0; seed < seeds; seed++) {
    const state = createArena(seed);
    const bots: Bot[] = [];
    for (let i = 0; i < aimers; i++) bots.push(newBot(joinPlayer(state, `aimer ${i}`, i % 2 ? "spaces" : "tabs").id, seed * 7 + i));
    const step = () => {
      for (const b of bots) drive(state, b, POLICIES.aimer, true);
      stepArena(state);
    };
    while (state.queen.stage !== 2) step();
    hps.push(state.queen.maxHp);
    const from = state.tick;
    const until = from + Math.round(QUEEN_CAP_S / DT);
    let down = false;
    while (state.tick < until && !down) {
      step();
      down = state.events.queenDown !== null;
    }
    if (down) secs.push((state.tick - from) * DT);
    else {
      secs.push(QUEEN_CAP_S);
      capped++;
    }
  }
  const sorted = secs.sort((a, b) => a - b);
  return {
    seeds,
    aimers,
    median: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    capped,
    hp: quantile(hps.sort((a, b) => a - b), 0.5),
  };
}

export function formatQueen(r: QueenReport): string {
  const target = r.aimers === QUEEN_AIMERS ? ` (target < ${QUEEN_TARGET_S} s)` : "";
  return `queen (wave 5, ${r.hp} hp): ${r.aimers} aimer${r.aimers === 1 ? "" : "s"} on ${r.seeds} seeds: median ${r.median.toFixed(1)} s, p75 ${r.p75.toFixed(1)} s, capped ${r.capped}${target} (reported, not gated)`;
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
