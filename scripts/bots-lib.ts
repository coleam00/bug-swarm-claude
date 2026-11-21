// The pure half of `bun run bots`: arguments, the bots' names, how a bot wanders and aims, and
// the summary. No network here, so `bun test` covers it; `bots.ts` opens the sockets.
import { WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { nextRandom, type Rng } from "../src/shared/arena/rng";
import { TEAMS, type Team } from "../src/server/rules";

export const USAGE = "usage: bun run bots -- --url <base url> [--count 18] [--seconds 60]";

export type BotsArgs = { url: string; count: number; seconds: number };

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
    if (key !== "url" && !(INT_FLAG_NAMES as string[]).includes(key)) throw new Error(`unknown flag --${key}`);
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
  const out: BotsArgs = { url: url.href.replace(/\/+$/, ""), count: 0, seconds: 0 };
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

export type Tally = {
  joins: number;
  /** The arena id in each welcome. */
  arenas: Set<number>;
  /** Messages received from the server. */
  messages: number;
  /** Error messages, connect failures and unexpected closes, each with what it was. */
  errors: string[];
};

export function createTally(): Tally {
  return { joins: 0, arenas: new Set(), messages: 0, errors: [] };
}

type TickStats = { p50: number | null; p95: number | null } | null;

const ms = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${v.toFixed(2)} ms`);

/** The lines `bun run bots` prints at the end. */
export function formatSummary(args: BotsArgs, tally: Tally, seconds: number, tick: TickStats): string[] {
  const perSecond = seconds > 0 ? tally.messages / seconds : 0;
  const errorKinds = new Map<string, number>();
  for (const e of tally.errors) errorKinds.set(e, (errorKinds.get(e) ?? 0) + 1);
  const lines = [
    `bots: ${args.count} against ${args.url} for ${seconds.toFixed(1)} s`,
    `joins: ${tally.joins} of ${args.count}`,
    `arenas used: ${tally.arenas.size} (${[...tally.arenas].sort((a, b) => a - b).join(", ") || "none"})`,
    `messages received: ${tally.messages} (${perSecond.toFixed(1)}/s overall, ${(perSecond / Math.max(1, tally.joins)).toFixed(1)}/s per bot)`,
    `errors: ${tally.errors.length}${errorKinds.size ? ` (${[...errorKinds].map(([k, n]) => `${k} x${n}`).join(", ")})` : ""}`,
    `server tick: p50 ${ms(tick?.p50)}, p95 ${ms(tick?.p95)}${tick ? "" : " (stats unavailable)"}`,
  ];
  return lines;
}
