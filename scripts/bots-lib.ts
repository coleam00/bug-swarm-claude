// The pure half of `bun run bots`: arguments, the bots' names, how a bot wanders and aims, what a
// policy bot sees (from snapshots), and the summary. No network here, so `bun test` covers it;
// `bots.ts` opens the sockets.
import { bugDef } from "../src/shared/arena/bugs/registry";
import { BUG_KINDS, DT, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createObservation, setObservedBug, setObservedPickup, type Observation } from "../src/shared/arena/policies";
import type { Snapshot } from "../src/shared/arena/protocol";
import { nextRandom, type Rng } from "../src/shared/arena/rng";
import { TEAMS, type Team } from "../src/server/rules";

export const USAGE = "usage: bun run bots -- --url <base url> [--count 18] [--seconds 60] [--policy wander|mover|aimer|dasher]";

/** How bots play: `wander` (#52's walk and aim sweep, never firing) or a policy from policies.ts. */
export const BOT_POLICIES = ["wander", "mover", "aimer", "dasher"] as const;
export type BotPolicy = (typeof BOT_POLICIES)[number];
/** Bots aim and fire with the aimer unless told otherwise (#55). */
export const DEFAULT_BOT_POLICY: BotPolicy = "aimer";

export type BotsArgs = { url: string; count: number; seconds: number; policy: BotPolicy };

const INT_FLAGS = {
  count: { def: 18, min: 1, max: 1000 },
  seconds: { def: 60, min: 1, max: 3600 },
} as const;
type IntFlag = keyof typeof INT_FLAGS;
const INT_FLAG_NAMES = Object.keys(INT_FLAGS) as IntFlag[];

/** Parses `--url`, `--count` and `--seconds`, as `--x v` or `--x=v`. Throws a message on anything else. */
export function parseBotsArgs(argv: string[]): BotsArgs {
  const seen: Record<string, string> = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument "${arg}"`);
    const key = m[1]!;
    if (key !== "url" && key !== "policy" && !(INT_FLAG_NAMES as string[]).includes(key)) throw new Error(`unknown flag --${key}`);
    let value = m[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    seen[key] = value;
  }
  if (seen.url === undefined) throw new Error("--url is required");
  let url: URL;
  try {
    url = new URL(seen.url);
  } catch {
    throw new Error(`--url "${seen.url}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must be http or https");
  const policy = seen.policy ?? DEFAULT_BOT_POLICY;
  if (!(BOT_POLICIES as readonly string[]).includes(policy)) throw new Error(`--policy must be one of ${BOT_POLICIES.join(", ")}`);
  const out: BotsArgs = { url: url.href.replace(/\/+$/, ""), count: 0, seconds: 0, policy: policy as BotPolicy };
  for (const key of INT_FLAG_NAMES) {
    const { def, min, max } = INT_FLAGS[key];
    const raw = seen[key];
    const n = raw === undefined ? def : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be a whole number from ${min} to ${max}`);
    out[key] = n;
  }
  return out;
}

/** The arena's WebSocket for a base URL: ws(s)://host/ws. */
export function wsUrl(base: string): string {
  return base.replace(/^http/, "ws") + "/ws";
}

/**
 * Bot `i` (from 1) is `bots-01`, `bots-02`, ... `bots-1000`: names that pass the name rules and
 * are not the server's reserved `bot ` prefix (rules.test.ts checks both).
 */
export function botName(i: number): string {
  return `bots-${String(i).padStart(2, "0")}`;
}

/** Bots alternate teams, Tabs first. */
export function botTeam(i: number): Team {
  return TEAMS[(i - 1) % TEAMS.length]!;
}

// Wandering, in 50 ms steps.
/** A heading lasts 1 to 3 s. */
export const HEADING_STEPS = { min: 20, max: 60 };
/** Within this many units of a wall, a bot turns for the centre. */
export const WALL_AVOID = 150;
/** The aim turns at most this far per step, radians (a slow sweep). */
export const AIM_TURN = 0.08;

export type Wander = { heading: number; stepsLeft: number; aim: number; aimTarget: number };

export function createWander(): Wander {
  return { heading: 0, stepsLeft: 0, aim: 0, aimTarget: 0 };
}

/**
 * One step of a wandering bot at (x, y): a new random heading (and a new spot to aim at) every
 * 1 to 3 s, straight for the centre when near a wall, the aim sweeping toward its target. Writes
 * the move and the aim into `out`.
 */
export function stepWander(w: Wander, rng: Rng, x: number, y: number, out: { mx: number; my: number; aim: number }): void {
  const nearWall = x < WALL_AVOID || y < WALL_AVOID || x > WORLD_W - WALL_AVOID || y > WORLD_H - WALL_AVOID;
  if (nearWall) {
    w.heading = Math.atan2(WORLD_H / 2 - y, WORLD_W / 2 - x);
    w.stepsLeft = Math.max(w.stepsLeft, HEADING_STEPS.min);
  } else if (w.stepsLeft <= 0) {
    w.heading = nextRandom(rng) * Math.PI * 2 - Math.PI;
    w.stepsLeft = HEADING_STEPS.min + Math.floor(nextRandom(rng) * (HEADING_STEPS.max - HEADING_STEPS.min + 1));
    w.aimTarget = nextRandom(rng) * Math.PI * 2 - Math.PI;
  }
  w.stepsLeft--;
  let d = w.aimTarget - w.aim;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  w.aim += Math.max(-AIM_TURN, Math.min(AIM_TURN, d));
  if (w.aim > Math.PI) w.aim -= 2 * Math.PI;
  if (w.aim <= -Math.PI) w.aim += 2 * Math.PI;
  out.mx = Math.cos(w.heading);
  out.my = Math.sin(w.heading);
  out.aim = w.aim;
}

/** A random 32-hex player id, as a browser makes one. */
export function randomPlayerId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * What a policy bot sees, kept from its snapshots: itself (from its `p` row and `me`), every
 * bug, with each bug's velocity derived from how far it moved since the last snapshot that had it,
 * and every pickup on the floor (`f`, #73), as `bun run skill`'s observe sees them.
 */
export type ObservationTracker = { obs: Observation; update(m: Snapshot, you: number): void };

export function createObservationTracker(): ObservationTracker {
  const obs = createObservation();
  obs.world.w = WORLD_W;
  obs.world.h = WORLD_H;
  let last = new Map<number, { x: number; y: number; tick: number }>();
  let next = new Map<number, { x: number; y: number; tick: number }>();
  return {
    obs,
    update(m, you) {
      const s = obs.self;
      for (const p of m.p) {
        if (p[0] !== you) continue;
        s.x = p[1];
        s.y = p[2];
        s.vx = p[3];
        s.vy = p[4];
        s.aim = p[5];
      }
      s.alive = m.me.al === 1;
      s.heat = m.me.he;
      s.locked = m.me.lk === 1;
      s.dashReady = s.alive && m.me.dc === 0 && m.me.dk === 0;
      next.clear();
      for (let i = 0; i < m.b.length; i++) {
        const row = m.b[i]!;
        const [id, kind, x, y] = row;
        const before = last.get(id);
        const gap = before ? (m.tick - before.tick) * DT : 0;
        const vx = before && gap > 0 ? (x - before.x) / gap : 0;
        const vy = before && gap > 0 ? (y - before.y) / gap : 0;
        // A kind with a shell (#80) faces its row's tail angle; any other bug, or one with no tail, 0, 0.
        const k = BUG_KINDS[kind];
        const shelled = k !== undefined && bugDef(k).shell !== undefined && row.length > 4;
        const angle = shelled ? row[5]! : 0;
        setObservedBug(obs, i, x, y, vx, vy, shelled ? Math.cos(angle) : 0, shelled ? Math.sin(angle) : 0);
        next.set(id, { x, y, tick: m.tick });
      }
      obs.bugCount = m.b.length;
      for (let i = 0; i < m.f.length; i++) setObservedPickup(obs, i, m.f[i]![2], m.f[i]![3]);
      obs.pickupCount = m.f.length;
      [last, next] = [next, last];
    },
  };
}

export type Tally = {
  joins: number;
  /** The arena id in each welcome. */
  arenas: Set<number>;
  /** Messages received from the server. */
  messages: number;
  /** Error messages, connect failures and unexpected closes, each with what it was. */
  errors: string[];
  /** The score of every life the server ended (its "over" events). */
  lives: number[];
};

export function createTally(): Tally {
  return { joins: 0, arenas: new Set(), messages: 0, errors: [], lives: [] };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

type TickStats = { p50: number | null; p95: number | null } | null;

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v.toFixed(2)} ms`);

/** The lines `bun run bots` prints at the end. */
export function formatSummary(args: BotsArgs, tally: Tally, seconds: number, tick: TickStats): string[] {
  const perSecond = seconds > 0 ? tally.messages / seconds : 0;
  const errorKinds = new Map<string, number>();
  for (const e of tally.errors) errorKinds.set(e, (errorKinds.get(e) ?? 0) + 1);
  const lines = [
    `bots: ${args.count} (${args.policy}) against ${args.url} for ${seconds.toFixed(1)} s`,
    `joins: ${tally.joins} of ${args.count}`,
    `arenas used: ${tally.arenas.size} (${[...tally.arenas].sort((a, b) => a - b).join(", ") || "none"})`,
    `messages received: ${tally.messages} (${perSecond.toFixed(1)}/s overall, ${(perSecond / Math.max(1, tally.joins)).toFixed(1)}/s per bot)`,
    `lives ended: ${tally.lives.length}, median score ${median(tally.lives) ?? "-"}`,
    `errors: ${tally.errors.length}${errorKinds.size ? ` (${[...errorKinds].map(([k, n]) => `${k} x${n}`).join(", ")})` : ""}`,
    `server tick: p50 ${ms(tick?.p50)}, p95 ${ms(tick?.p95)}${tick ? "" : " (stats unavailable)"}`,
  ];
  return lines;
}
