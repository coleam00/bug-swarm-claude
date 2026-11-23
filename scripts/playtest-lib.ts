// The pure half of `bun run playtest` (#94): arguments, where Chrome is, the pages' names, teams
// and devices, what each page recorded, the scripted "human" each page plays, how its intent
// becomes real mouse, keyboard or touch input, and the checks that the pages' screens agree. No
// I/O, no clock and no Math.random here (randomness from rng.ts, seeded per page), so `bun test`
// covers it; `playtest.ts` drives Chrome.
//
// A page's view of the shared state is what it received: its WebSocket frames, stamped with
// Chrome's receipt time (the DevTools `timestamp`, one clock for every page in the browser), its
// /api/top responses and its life-over screen. It draws the frames INTERP_DELAY_MS later, so two
// screens agree when they received the same content by id within INTERP_DELAY_MS of each other.
// Since #89 each page is sent its own view (bugs, pickups and kills culled to a square around its
// camera, as deltas between keyframes), so the checks compare what two pages both had, by id.
// Ticks, player ids, bug ids, arena ids and input seqs all start again with a new server process
// (the restart scenario, #95), so every record carries `gen`, the server lifetime it came from,
// and every check compares within one lifetime only.
// Every page gets every player and every down; the players come as deltas against what that
// socket was sent before, so their positions are compared too (a page's own row carries its exact
// `me` numbers and is left out).
import { join } from "node:path";
import { ACCEL, DT, FILL_TARGET, INTERP_DELAY_MS, MAX_SPEED, REVIVE_RANGE, WAVE_S, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import {
  DOWN,
  ERROR,
  EVENT,
  INPUT,
  JOIN,
  LEAVE,
  OVER,
  REVIVE,
  SNAPSHOT,
  QUEEN,
  WELCOME,
  ERROR_RESTARTING,
  type ArenaEvent,
  type ErrorCode,
  type ServerMessage,
  type InputMessage,
  type RosterEntry,
  type SnapshotBug,
  type SnapshotDown,
  type SnapshotKill,
  type SnapshotMe,
  type SnapshotPlayer,
  type SnapshotQueen,
} from "../src/shared/arena/protocol";
import { QUEEN_EVERY_WAVES } from "../src/shared/arena/bugs/queen";
import { createRng, nextRandom, type Rng } from "../src/shared/arena/rng";
import { NAME_MAX, TEAMS, type Team } from "../src/server/rules";
import { CAMERA_SECONDS, createCamera, snapCamera, type Camera } from "../src/web/arena/camera";
import { dashButtonAt } from "../src/web/arena/controls";
import { STICK_DEAD, STICK_RANGE } from "../src/web/game/stick";
import type { TopRow } from "../src/web/api";
import { QUEEN_CAP_S } from "./skill-lib";

export const USAGE = "usage: bun run playtest -- (--url <base url> | --serve) [--players 4] [--seconds 90] [--scenario basic|revive|late-join|restart|queen] [--chrome <path>] [--headed]";

// ---- Scenarios ----

/** Every scenario #94 names. Those with no follow-up issue run; the rest name the issue that tracks them. */
export const SCENARIO_NAMES = ["basic", "revive", "late-join", "restart", "queen"] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

/**
 * What a page plays: `fighter` (roam, fight, dash from contact, revive anyone down), `keepaway`
 * (fights, never revives, keeps KEEPAWAY_UNITS from the victim so it can't revive by accident:
 * revive is proximity, downs.ts), `reviver` (fights near the victim, revives only it), `victim`
 * (walks into bugs, never fires or dashes, until it has been revived once; then a keepaway).
 */
export const ROLES = ["fighter", "keepaway", "reviver", "victim"] as const;
export type Role = (typeof ROLES)[number];

export type Scenario = {
  name: ScenarioName;
  /** Null when it runs; else the issue that tracks it. */
  followUp: number | null;
  why: string;
  minPlayers: number;
  roles: (n: number) => Role[];
};

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  basic: { name: "basic", followUp: null, why: "", minPlayers: 2, roles: (n) => Array.from({ length: n }, () => "fighter") },
  // With FILL_TARGET people no new fill bot is added, but bots added while the pages were joining
  // stay until their life ends, and a bot can revive the victim: the scenario waits for the reviver's.
  revive: {
    name: "revive",
    followUp: null,
    why: "",
    minPlayers: FILL_TARGET,
    roles: (n) => Array.from({ length: n }, (_, i): Role => (i === 0 ? "victim" : i === 1 ? "reviver" : "keepaway")),
  },
  // The early pages, and one more page that joins once the arena reads LATE_JOIN_WAVE (#95).
  "late-join": { name: "late-join", followUp: null, why: "", minPlayers: 3, roles: (n) => Array.from({ length: n }, () => "fighter") },
  // The server restarts mid-fight through its graceful path and every page rejoins (#95). Needs --serve.
  restart: { name: "restart", followUp: null, why: "", minPlayers: 2, roles: (n) => Array.from({ length: n }, () => "fighter") },
  // Every page fights with queen focus (Plan.queenFirst): it plays on until the hive queen's `q`
  // shows, then fights her until her `queen` event (#96).
  queen: { name: "queen", followUp: null, why: "", minPlayers: 2, roles: (n) => Array.from({ length: n }, () => "fighter") },
};

/** The late-join scenario's last page joins once an early page's snapshot reads this wave: (LATE_JOIN_WAVE - 1) * WAVE_S s in (sim.ts `wave`). */
export const LATE_JOIN_WAVE = 6;
/** The late page plays at least this long after its first snapshot, s. */
export const LATE_PLAY_S = 30;
/** If no early page reads LATE_JOIN_WAVE by this many seconds of play, the run stops (and fails). */
export const LATE_JOIN_CAP_S = (LATE_JOIN_WAVE - 1) * WAVE_S + 60;

/** The restart scenario plays this long before it restarts the server, s. */
export const RESTART_AT_S = 40;
/** Every page must have rejoined (a welcome from the new server) within this of the restart starting, s. */
export const REJOIN_CAP_S = 30;
/** After the last page rejoins it plays on this long, s. */
export const AFTER_RESTART_S = 40;

/** The queen scenario's wave: the hive queen comes on the first tick of every QUEEN_EVERY_WAVES-th wave (#85). */
export const QUEEN_WAVE = QUEEN_EVERY_WAVES;
/** If no page's `q` is non-empty by this many seconds of play, the run stops (and fails). */
export const QUEEN_APPEAR_CAP_S = (QUEEN_WAVE - 1) * WAVE_S + 60;
/** If she is still alive this long after any page first read her alive, the run stops (and fails): `bun run skill`'s cap on her kill. */
export const QUEEN_KILL_CAP_S = QUEEN_CAP_S;
/** Play goes on this long after her `queen` event, so every page has it and the `q` of `[]` after it, s. */
export const QUEEN_AFTER_S = 5;

// ---- Arguments ----

/** `url`: the server to play against, null with `serve` (the playtest starts its own and sets it). */
export type PlaytestArgs = { url: string | null; serve: boolean; players: number; seconds: number; scenario: ScenarioName; chrome: string | null; headed: boolean };

const INT_FLAGS = {
  players: { def: 4, min: 2, max: 20 },
  seconds: { def: 90, min: 10, max: 3600 },
} as const;

/**
 * Parses `--url` or `--serve`, `--players`, `--seconds`, `--scenario`, `--chrome` (`--x v` or
 * `--x=v`) and `--headed`. Throws a message on anything else, on both or neither of `--url` and
 * `--serve`, and on `restart` without `--serve`.
 */
export function parseArgs(argv: string[]): PlaytestArgs {
  const seen: Record<string, string> = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument "${arg}"`);
    const key = m[1]!;
    if (key === "headed" || key === "serve") {
      if (m[2] !== undefined) throw new Error(`--${key} takes no value`);
      seen[key] = "1";
      continue;
    }
    if (!["url", "players", "seconds", "scenario", "chrome"].includes(key)) throw new Error(`unknown flag --${key}`);
    let value = m[2];
    if (value === undefined) {
      value = args[++i];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    seen[key] = value;
  }
  const serve = seen.serve === "1";
  if (seen.url === undefined && !serve) throw new Error("--url or --serve is required");
  if (seen.url !== undefined && serve) throw new Error("--url and --serve: pick one");
  let url: URL | null = null;
  if (seen.url !== undefined) {
    try {
      url = new URL(seen.url);
    } catch {
      throw new Error(`--url "${seen.url}" is not a URL`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must be http or https");
  }
  const scenario = seen.scenario ?? "basic";
  if (!(SCENARIO_NAMES as readonly string[]).includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIO_NAMES.join(", ")}`);
  if (scenario === "restart" && !serve) throw new Error("restart needs --serve: the playtest must own the server to restart it");
  const int = (key: keyof typeof INT_FLAGS): number => {
    const f = INT_FLAGS[key];
    if (seen[key] === undefined) return f.def;
    const n = Number(seen[key]);
    if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`--${key} must be a whole number from ${f.min} to ${f.max}`);
    return n;
  };
  return {
    url: url ? url.href.replace(/\/+$/, "") : null,
    serve,
    players: int("players"),
    seconds: int("seconds"),
    scenario: scenario as ScenarioName,
    chrome: seen.chrome ?? null,
    headed: seen.headed === "1",
  };
}

/**
 * The environment `--serve` starts `bun src/server/main.ts` with: a fixed PORT (the same one
 * after a restart, so the pages' rejoins reach it), a scratch DATA_DIR, and a fixed BUILD_ID (so a
 * rejoin is not refused as another build, which would show "Updating..." and reload). Without
 * RAILWAY_GIT_COMMIT_SHA (it beats BUILD_ID), NODE_ENV (production listens on every interface)
 * and an inherited BUG_SWARM_START_WAVE (late-join needs the real wave 6). `startWave` sets it
 * instead: the queen scenario passes QUEEN_WAVE, so each new arena opens 10 s before her wave (#96).
 * With BUG_SWARM_ALLOW_LOAD=1 (#104): every page connects from 127.0.0.1, and the restart scenario's
 * rejoins add sockets and joins, so the per-address /ws limits are off on this scratch server.
 */
export function serverEnv(base: Record<string, string | undefined>, port: number, dataDir: string, buildId: string, startWave: number | null = null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const k of ["RAILWAY_GIT_COMMIT_SHA", "NODE_ENV", "BUG_SWARM_START_WAVE"]) delete out[k];
  if (startWave !== null) out.BUG_SWARM_START_WAVE = String(startWave);
  out.PORT = String(port);
  out.DATA_DIR = dataDir;
  out.BUILD_ID = buildId;
  out.BUG_SWARM_ALLOW_LOAD = "1";
  return out;
}

// ---- Chrome ----

/**
 * Where to look for Chrome, in order: `--chrome`, then CHROME_PATH, then the usual install places
 * for the platform. On Linux the bare names are looked up on PATH by the caller.
 */
export function chromeCandidates(platform: string, env: Record<string, string | undefined>, flag: string | null = null): string[] {
  const out: string[] = [];
  if (flag) out.push(flag);
  if (env.CHROME_PATH) out.push(env.CHROME_PATH);
  if (platform === "win32") {
    for (const dir of [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]) {
      if (dir) out.push(join(dir, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (platform === "darwin") {
    out.push(join("/Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"));
  } else {
    out.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  return out;
}

// ---- Pages ----

export type Device = { touch: boolean; width: number; height: number; scale: number };
/**
 * A desktop with a mouse and keyboard, and a phone in portrait with two-point touch. The phone is
 * emulated at device scale 1: at 2, Chrome's emulation delivered the first touch of each new
 * touch sequence at half its coordinates (measured, #94), which put the move thumb in the wrong place.
 */
export const DESKTOP: Device = { touch: false, width: 1280, height: 800, scale: 1 };
export const PHONE: Device = { touch: true, width: 390, height: 844, scale: 1 };

/** `late`: the late-join scenario's late page (the last one), opened once the arena reads LATE_JOIN_WAVE. */
export type PageSpec = { index: number; name: string; team: Team; device: Device; role: Role; seed: number; late: boolean };

const LETTERS = "ABCDEFGHIJKLMNOPQRST";

/**
 * The pages: names `PT<tag>-<letter>` (the tag tells runs apart on the top 10), teams alternating
 * over TEAMS, every second page a touch phone, and each page's role in the scenario.
 */
export function pageSpecs(n: number, scenario: ScenarioName, seed: number): PageSpec[] {
  const tag = (seed >>> 0).toString(36).slice(-3).toUpperCase();
  const roles = SCENARIOS[scenario].roles(n);
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    name: `PT${tag}-${LETTERS[i]}`.slice(0, NAME_MAX),
    team: TEAMS[i % TEAMS.length]!,
    device: i % 2 === 0 ? DESKTOP : PHONE,
    role: roles[i] ?? "fighter",
    seed: (seed + i * 7919) | 0,
    late: scenario === "late-join" && i === n - 1,
  }));
}

// ---- Recording ----

/** A snapshot as kept: what the checks read (the bugs, shots and floor are dropped to save memory). `q`: the hive queen, decoded (her marker's ticks left). */
export type Kept = { tick: number; ack: number; p: SnapshotPlayer[]; k: SnapshotKill[]; d: SnapshotDown[]; w: number; q: SnapshotQueen; me: SnapshotMe };
/**
 * `at`: Chrome's receipt time, ms; `hat`: the harness's clock when it heard, ms; `you`: the page's
 * id then; `gen`: the server lifetime it came from (its connection's welcome's, connGen).
 */
export type FrameRec = { at: number; hat: number; you: number; gen: number; s: Kept };
/** An event, with the tick whose step raised it (the server sends a step's events before its snapshot). */
export type EventRec = { at: number; tick: number; you: number; gen: number; ev: ArenaEvent };
/** `gen`: the harness's server lifetime when it arrived. */
export type WelcomeRec = { at: number; you: number; gen: number; arena: number; build: string; roster: RosterEntry[] };
/** `gen`: the harness's server lifetime when the response arrived (a page on the life-over screen reads the top 10 before it rejoins). */
export type TopRec = { at: number; gen: number; rows: TopRow[] };
/** An input the page sent, at the harness's clock. */
export type SentRec = { hat: number; gen: number; msg: InputMessage };
/** An error the server sent (`restarting` before a restart). */
export type ErrorRec = { at: number; gen: number; code: ErrorCode };
/**
 * What the harness dispatched: the move as the keys or stick gave it (unit or 0), the aim, fire and
 * dash. `hat` is when its dispatch began and `done` when Chrome had taken every event of it.
 */
export type IntentRec = { hat: number; done: number; mode: string; mx: number; my: number; aim: number | null; fire: boolean; dash: boolean };
/** The life-over screen's score as shown, for the page's n-th over event. */
export type ScreenRec = { over: number; text: string | null };

export type PageLog = {
  index: number;
  name: string;
  team: Team;
  touch: boolean;
  role: Role;
  late: boolean;
  /** The server lifetime now: 0, and one more each time the harness restarts the server (set by the harness). */
  gen: number;
  /** The page's id now (0 until a player welcome; a watching welcome is `you: 0`). */
  you: number;
  welcomes: WelcomeRec[];
  frames: FrameRec[];
  events: EventRec[];
  tops: TopRec[];
  sent: SentRec[];
  intents: IntentRec[];
  screens: ScreenRec[];
  errors: ErrorRec[];
};

export function createLog(spec: PageSpec): PageLog {
  return { index: spec.index, name: spec.name, team: spec.team, touch: spec.device.touch, role: spec.role, late: spec.late, gen: 0, you: 0, welcomes: [], frames: [], events: [], tops: [], sent: [], intents: [], screens: [], errors: [] };
}

/**
 * Records one message the page received, decoded as the page decodes it (protocol.ts
 * parseServerMessage, then that socket's view.ts createSnapshotReader; null: a delta it could not
 * apply, which the page drops too). Messages before its first player welcome (the start screen's
 * watching socket) are skipped. A welcome takes the log's current `gen`; everything else takes its
 * connection's (connGen), so a frame from the old server that arrives late keeps the old one.
 */
export function addFrame(log: PageLog, at: number, hat: number, m: ServerMessage | null): void {
  if (!m) return;
  if (m.t === WELCOME) {
    if (m.you !== 0) {
      log.you = m.you;
      log.welcomes.push({ at, you: m.you, gen: log.gen, arena: m.arena, build: m.build, roster: m.roster });
    } else log.you = 0;
    return;
  }
  if (m.t === ERROR) {
    log.errors.push({ at, gen: connGen(log), code: m.code });
    return;
  }
  if (log.you === 0) return;
  const gen = connGen(log);
  if (m.t === SNAPSHOT) {
    log.frames.push({ at, hat, you: log.you, gen, s: { tick: m.tick, ack: m.ack, p: m.p, k: m.k, d: m.d, w: m.w, q: m.q, me: m.me } });
  } else if (m.t === EVENT) {
    const last = log.frames[log.frames.length - 1];
    const sinceWelcome = last && last.at >= log.welcomes[log.welcomes.length - 1]!.at;
    log.events.push({ at, tick: sinceWelcome ? last.s.tick + 1 : -1, you: log.you, gen, ev: m });
  }
}

/** The server lifetime of the page's connection: its latest player welcome's, else the log's. */
export function connGen(log: PageLog): number {
  return log.welcomes[log.welcomes.length - 1]?.gen ?? log.gen;
}

/** Records an input the page sent (other frames it sent are ignored). */
export function addSent(log: PageLog, hat: number, raw: string): void {
  if (log.you === 0) return;
  try {
    const m = JSON.parse(raw) as InputMessage;
    if (m && m.t === INPUT) log.sent.push({ hat, gen: connGen(log), msg: m });
  } catch {
    // Not an input.
  }
}

// ---- The scripted human ----

/** A bug this close (units, centre to centre) is contact: dash away, or walk away while the dash cools. */
export const CONTACT_UNITS = 70;
/** A fighter keeps about this far from the nearest bug it is shooting. */
export const KEEP_UNITS = 250;
/** Between KEEP_UNITS and this, a fighter strafes round the bug instead of turning back and forth at one distance. */
export const STRAFE_UNITS = KEEP_UNITS + 120;
/** Keep-away pages stay this far from the victim. */
export const KEEPAWAY_UNITS = 200;
/** The reviver keeps within this of the victim, so it can reach it before it bleeds out. */
export const ESCORT_UNITS = 220;
/** A reviver walks until this close to the downed player, inside REVIVE_RANGE. */
export const REVIVE_HOLD_UNITS = REVIVE_RANGE * 0.6;
/** Pages that never revive keep this far from anyone down. */
export const AVOID_DOWN_UNITS = REVIVE_RANGE * 2;
/** Fire bursts, seconds: on for 0.6 to 1.2, off for 0.3 to 0.6. */
export const BURST_ON_S = [0.6, 1.2] as const;
export const BURST_OFF_S = [0.3, 0.6] as const;
/** A new wander point at most this often, seconds, or once reached. */
export const WANDER_S = [4, 8] as const;
const WANDER_MARGIN = 200;
/**
 * With queen focus a page stands off her at least this far, units (twice CONTACT_UNITS: her radius
 * is 40), and strafes round her out to QUEEN_FAR_SHARE of the nearer half of its view. Not
 * KEEP_UNITS: a phone's view is 370 units wide, so at 250 she would leave its screen.
 */
export const QUEEN_NEAR_UNITS = CONTACT_UNITS * 2;
export const QUEEN_FAR_SHARE = 0.9;

export type Plan = {
  role: Role;
  rng: Rng;
  firing: boolean;
  burstUntil: number;
  wander: { x: number; y: number };
  wanderUntil: number;
  /** The end phase: stop firing, walk at bugs, never revive, so every life ends. */
  giveUp: boolean;
  /** The victim's id, for the reviver and keep-away pages (0: none). */
  partner: number;
  /** Which way it strafes round a bug: 1 or -1, picked again with each new wander point. */
  strafe: number;
  /** The queen scenario (#96): while the hive queen is alive it shoots her when she is on screen and walks to her when not. */
  queenFirst: boolean;
};

export function createPlan(role: Role, seed: number): Plan {
  return { role, rng: createRng(seed), firing: false, burstUntil: 0, wander: { x: WORLD_W / 2, y: WORLD_H / 2 }, wanderUntil: 0, giveUp: false, partner: 0, strafe: 1, queenFirst: false };
}

/** What a page sees: its own row and numbers, every bug and player in the arena, who is down, and its camera's view. */
export type View = {
  you: number;
  me: SnapshotPlayer | null;
  nums: SnapshotMe;
  players: SnapshotPlayer[];
  bugs: SnapshotBug[];
  downs: SnapshotDown[];
  /** The hive queen as the snapshot's `q` (never culled, unlike her bug row). */
  queen: SnapshotQueen;
  /** The view's centre and size, world units. */
  cam: Pick<Camera, "x" | "y" | "w" | "h">;
};

export type Intent = { mode: string; mx: number; my: number; aim: number | null; fire: boolean; dash: boolean };

const range = (rng: Rng, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * nextRandom(rng);

/** The camera a page has around (x, y): createCamera's view for its screen, snapped there. */
export function cameraAt(device: Device, x: number, y: number): Camera {
  const cam = createCamera(device.width, device.height);
  snapCamera(cam, x, y);
  return cam;
}

/** On screen: inside the camera's view. */
export function onScreen(cam: View["cam"], x: number, y: number): boolean {
  return Math.abs(x - cam.x) <= cam.w / 2 && Math.abs(y - cam.y) <= cam.h / 2;
}

function unit(dx: number, dy: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy);
  return d === 0 ? { x: 0, y: 0 } : { x: dx / d, y: dy / d };
}

function nearestBug(bugs: SnapshotBug[], x: number, y: number, cam: View["cam"] | null): { b: SnapshotBug; d: number } | null {
  let best: SnapshotBug | null = null;
  let bestD = Infinity;
  for (const b of bugs) {
    if (cam && !onScreen(cam, b[2], b[3])) continue;
    const d = Math.hypot(b[2] - x, b[3] - y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best ? { b: best, d: bestD } : null;
}

const IDLE = (mode: string): Intent => ({ mode, mx: 0, my: 0, aim: null, fire: false, dash: false });

/** The burst clock: fire for BURST_ON_S, rest for BURST_OFF_S, seeded. */
function burst(plan: Plan, t: number): boolean {
  if (t >= plan.burstUntil) {
    plan.firing = !plan.firing;
    plan.burstUntil = t + range(plan.rng, plan.firing ? BURST_ON_S : BURST_OFF_S);
  }
  return plan.firing;
}

function wanderTo(plan: Plan, x: number, y: number, t: number): { x: number; y: number } {
  if (t >= plan.wanderUntil || Math.hypot(plan.wander.x - x, plan.wander.y - y) < 60) {
    plan.wander = { x: WANDER_MARGIN + nextRandom(plan.rng) * (WORLD_W - 2 * WANDER_MARGIN), y: WANDER_MARGIN + nextRandom(plan.rng) * (WORLD_H - 2 * WANDER_MARGIN) };
    plan.wanderUntil = t + range(plan.rng, WANDER_S);
    plan.strafe = nextRandom(plan.rng) < 0.5 ? -1 : 1;
  }
  return unit(plan.wander.x - x, plan.wander.y - y);
}

function rowOf(players: SnapshotPlayer[], id: number): SnapshotPlayer | null {
  for (const p of players) if (p[0] === id) return p;
  return null;
}

/**
 * The scripted human: one decision from what the page sees at `t` seconds. Out or down, it does
 * nothing (the life-over screen and the revive are the harness's and the server's). Otherwise, in
 * order: the end phase walks at bugs; the victim walks at bugs; a downed player it may revive is
 * walked to and stood by; a bug in contact is dashed from (or walked from while the dash cools);
 * the nearest bug on screen is aimed at and fired at in bursts while keeping KEEP_UNITS from it
 * (backing off inside it, strafing round it out to STRAFE_UNITS);
 * else it wanders. Pages that never revive keep away from anyone down, and keep-away pages from
 * the victim. With queen focus (#96), while `q` reads her alive, she is the target whenever she is
 * on screen (aimed at through revives and evades too), and the page stands off her between
 * QUEEN_NEAR_UNITS and the edge of its view; off screen, it walks to her.
 */
export function decide(view: View, plan: Plan, t: number): Intent {
  const me = view.me;
  if (!me || view.nums.al === 0 || me[6] === 0) return IDLE("out");
  if (view.nums.dn === 1) return IDLE("down");
  const x = me[1];
  const y = me[2];
  const all = nearestBug(view.bugs, x, y, null);
  const seen = nearestBug(view.bugs, x, y, view.cam);
  const revives = (plan.role === "fighter" || plan.role === "reviver") && !plan.giveUp;

  // Away from anyone down that this page must not revive.
  let avoid: { x: number; y: number } | null = null;
  if (!revives) {
    for (const d of view.downs) {
      if (d[0] === view.you) continue;
      const r = rowOf(view.players, d[0]);
      if (r && Math.hypot(r[1] - x, r[2] - y) < AVOID_DOWN_UNITS) avoid = unit(x - r[1], y - r[2]);
    }
  }
  if (plan.role === "keepaway" && plan.partner !== 0) {
    const v = rowOf(view.players, plan.partner);
    if (v && v[6] === 1 && Math.hypot(v[1] - x, v[2] - y) < KEEPAWAY_UNITS) avoid = unit(x - v[1], y - v[2]);
  }

  if (plan.giveUp || plan.role === "victim") {
    if (avoid) return { mode: plan.giveUp ? "give-up" : "victim", mx: avoid.x, my: avoid.y, aim: null, fire: false, dash: false };
    const to = all ? unit(all.b[2] - x, all.b[3] - y) : wanderTo(plan, x, y, t);
    return { mode: plan.giveUp ? "give-up" : "victim", mx: to.x, my: to.y, aim: null, fire: false, dash: false };
  }

  // Queen focus: her position from `q` ([1, id, x, y, hp, maxHp]).
  const q = plan.queenFirst && view.queen[0] === 1 ? { x: view.queen[2], y: view.queen[3] } : null;
  const qSeen = q !== null && onScreen(view.cam, q.x, q.y);
  const target = qSeen ? q : seen ? { x: seen.b[2], y: seen.b[3] } : null;
  const aim = target ? Math.atan2(target.y - y, target.x - x) : null;
  const fire = target ? burst(plan, t) : false;

  if (revives) {
    let target: SnapshotPlayer | null = null;
    let bestD = Infinity;
    for (const d of view.downs) {
      if (d[0] === view.you) continue;
      if (plan.role === "reviver" && d[0] !== plan.partner) continue;
      const r = rowOf(view.players, d[0]);
      if (!r) continue;
      const dist = Math.hypot(r[1] - x, r[2] - y);
      if (dist < bestD) {
        bestD = dist;
        target = r;
      }
    }
    if (target) {
      const to = bestD > REVIVE_HOLD_UNITS ? unit(target[1] - x, target[2] - y) : { x: 0, y: 0 };
      return { mode: "revive", mx: to.x, my: to.y, aim, fire, dash: false };
    }
  }

  if (all && all.d < CONTACT_UNITS) {
    const away = unit(x - all.b[2], y - all.b[3]);
    const canDash = view.nums.dc === 0 && view.nums.dk === 0;
    return { mode: "evade", mx: away.x, my: away.y, aim: aim ?? Math.atan2(-away.y, -away.x), fire, dash: canDash };
  }

  if (q && !avoid) {
    const d = Math.hypot(q.x - x, q.y - y);
    if (!qSeen) {
      const to = unit(q.x - x, q.y - y);
      return { mode: "queen-seek", mx: to.x, my: to.y, aim, fire, dash: false };
    }
    const far = Math.max(QUEEN_NEAR_UNITS + 30, (QUEEN_FAR_SHARE * Math.min(view.cam.w, view.cam.h)) / 2);
    let move: { x: number; y: number };
    if (d < QUEEN_NEAR_UNITS) move = unit(x - q.x, y - q.y);
    else if (d < far) {
      wanderTo(plan, x, y, t);
      move = unit(-(q.y - y) * plan.strafe, (q.x - x) * plan.strafe);
    } else move = unit(q.x - x, q.y - y);
    return { mode: "queen", mx: move.x, my: move.y, aim, fire, dash: false };
  }

  let move: { x: number; y: number };
  if (avoid) move = avoid;
  else if (plan.role === "reviver" && plan.partner !== 0 && (() => {
    const v = rowOf(view.players, plan.partner);
    return v !== null && v[6] === 1 && Math.hypot(v[1] - x, v[2] - y) > ESCORT_UNITS;
  })()) {
    const v = rowOf(view.players, plan.partner)!;
    move = unit(v[1] - x, v[2] - y);
  } else if (seen && seen.d < KEEP_UNITS) move = unit(x - seen.b[2], y - seen.b[3]);
  else if (seen && seen.d < STRAFE_UNITS) {
    wanderTo(plan, x, y, t);
    move = unit(-(seen.b[3] - y) * plan.strafe, (seen.b[2] - x) * plan.strafe);
  } else move = wanderTo(plan, x, y, t);
  return { mode: seen ? "fight" : "roam", mx: move.x, my: move.y, aim, fire, dash: false };
}

// ---- Intent to input ----

/** A move component past this sets its key (about 22.5 degrees off the axis). */
const KEY_THRESHOLD = Math.sin(Math.PI / 8);

/** The WASD keys (KeyboardEvent.code) for a move: diagonals hold two. */
export function moveKeys(mx: number, my: number): string[] {
  const keys: string[] = [];
  if (my < -KEY_THRESHOLD) keys.push("KeyW");
  if (mx < -KEY_THRESHOLD) keys.push("KeyA");
  if (my > KEY_THRESHOLD) keys.push("KeyS");
  if (mx > KEY_THRESHOLD) keys.push("KeyD");
  return keys;
}

/** The move the keys give, as a unit vector (or 0): what the page will send. */
export function keysMove(keys: string[]): { x: number; y: number } {
  const dx = (keys.includes("KeyD") ? 1 : 0) - (keys.includes("KeyA") ? 1 : 0);
  const dy = (keys.includes("KeyS") ? 1 : 0) - (keys.includes("KeyW") ? 1 : 0);
  return unit(dx, dy);
}

/** How far from the robot the mouse sits on screen, CSS px. */
export const MOUSE_REACH = 250;

/**
 * Where the mouse goes to aim at `aim` from the robot at world (x, y) moving at (vx, vy), on
 * `device`, in CSS px, inside the screen. The camera trails a moving robot by its velocity times
 * CAMERA_SECONDS (camera.ts follows exponentially), so the robot is drawn that far ahead of the
 * camera's centre.
 */
export function mouseAt(device: Device, x: number, y: number, vx: number, vy: number, aim: number): { x: number; y: number } {
  const cam = cameraAt(device, x - vx * CAMERA_SECONDS, y - vy * CAMERA_SECONDS);
  const sx = (x - cam.x) * cam.scale + device.width / 2;
  const sy = (y - cam.y) * cam.scale + device.height / 2;
  return {
    x: Math.min(device.width - 2, Math.max(2, sx + Math.cos(aim) * MOUSE_REACH)),
    y: Math.min(device.height - 2, Math.max(2, sy + Math.sin(aim) * MOUSE_REACH)),
  };
}

/** How far the aim thumb is dragged, CSS px: past STICK_DEAD, so it aims and fires. */
export const AIM_DRAG = STICK_DEAD * 6;

export type TouchLayout = { left: { x: number; y: number }; right: { x: number; y: number }; dash: { x: number; y: number } };

/** Where the thumbs land (the floating sticks' centres: left half moves, right half aims) and the dash button (no safe-area insets in Chrome). */
export function touchLayout(device: Device): TouchLayout {
  const b = dashButtonAt(device.width, device.height, { top: 0, right: 0, bottom: 0, left: 0 }, { x: 0, y: 0, r: 0, id: -1 });
  const y = device.height - 110;
  return { left: { x: device.width * 0.22, y }, right: { x: device.width * 0.72, y }, dash: { x: b.x, y: b.y } };
}

export type TouchPoint = { id: number; x: number; y: number };
/** Finger ids: the move thumb, the aim thumb and the dash tap. */
export const MOVE_FINGER = 1;
export const AIM_FINGER = 2;
export const DASH_FINGER = 3;

/**
 * The two thumbs for an intent: the move thumb dragged the full STICK_RANGE along the move (at its
 * centre: standing), the aim thumb dragged AIM_DRAG along the aim while firing (a touch screen aims
 * only while the aim stick is held past its dead zone, and that fires), else at its centre.
 */
export function touchPoints(layout: TouchLayout, intent: Intent): [TouchPoint, TouchPoint] {
  const m = unit(intent.mx, intent.my);
  const aiming = intent.fire && intent.aim !== null;
  return [
    { id: MOVE_FINGER, x: layout.left.x + m.x * STICK_RANGE, y: layout.left.y + m.y * STICK_RANGE },
    { id: AIM_FINGER, x: layout.right.x + (aiming ? Math.cos(intent.aim!) * AIM_DRAG : 0), y: layout.right.y + (aiming ? Math.sin(intent.aim!) * AIM_DRAG : 0) },
  ];
}

// ---- Checks ----

export type CheckResult = { name: string; pass: boolean; detail: string };

/** The id-to-name roster a page knew at `at`: its last welcome by then, then the joins and leaves it received after it, up to `at`. */
export function rosterAt(log: PageLog, at: number): Map<number, string> {
  const out = new Map<number, string>();
  let w: WelcomeRec | undefined;
  for (const x of log.welcomes) if (x.at <= at) w = x;
  if (!w) return out;
  for (const r of w.roster) out.set(r.id, r.name);
  for (const e of log.events) {
    if (e.at < w.at || e.at > at) continue;
    if (e.ev.kind === JOIN) out.set(e.ev.id, e.ev.name ?? "");
    else if (e.ev.kind === LEAVE) out.delete(e.ev.id);
  }
  return out;
}

/** The id-to-name roster a page knows at the end. */
export const rosterOf = (log: PageLog): Map<number, string> => rosterAt(log, Infinity);

/** The server lifetimes the pages saw, in order. */
function gens(logs: PageLog[]): number[] {
  return [...new Set(logs.flatMap((l) => l.welcomes.map((w) => w.gen)))].sort((a, b) => a - b);
}

/** a. Every page joined the same arena, in each server lifetime (each page's first welcome in it). */
export function checkSameArena(logs: PageLog[]): CheckResult {
  const missing: string[] = [];
  const parts: string[] = [];
  let pass = true;
  const all = gens(logs);
  for (const g of all.length > 0 ? all : [0]) {
    const arenas = logs.map((l) => l.welcomes.find((w) => w.gen === g)?.arena ?? null);
    for (const [i, a] of arenas.entries()) if (a === null) missing.push(all.length > 1 ? `${logs[i]!.name} (server ${g})` : logs[i]!.name);
    const distinct = new Set(arenas.filter((a) => a !== null));
    if (distinct.size !== 1) pass = false;
    const label = all.length > 1 ? `server ${g}: ` : "";
    parts.push(distinct.size === 1 ? `${label}arena ${[...distinct][0]}` : `${label}arenas ${arenas.join(", ")}`);
  }
  pass &&= missing.length === 0;
  return { name: "same arena", pass, detail: missing.length > 0 ? `never joined: ${missing.join(", ")}` : parts.join("; ") };
}

/**
 * b. At the end of each server lifetime every page's roster holds every page, by its id in that
 * lifetime and its name. An earlier lifetime is read at the page's last snapshot from it: a
 * stopping server ends every life and sends each member's leave after its last snapshot (the
 * last lifetime is read at the end of the run).
 */
export function checkRoster(logs: PageLog[]): CheckResult {
  const wrong: string[] = [];
  const all = gens(logs);
  const last = all[all.length - 1] ?? 0;
  for (const g of all) {
    const ids = logs.map((o) => o.welcomes.filter((w) => w.gen === g).at(-1)?.you ?? 0);
    for (const l of logs) {
      const end = g === last ? Infinity : Math.max(...l.frames.filter((f) => f.gen === g).map((f) => f.at));
      const r = rosterAt(l, end);
      logs.forEach((o, i) => {
        const id = ids[i]!;
        if (id === 0) wrong.push(`${o.name} never joined${all.length > 1 ? ` server ${g}` : ""}`);
        else if (r.get(id) !== o.name) wrong.push(`${l.name} lacks ${o.name}${all.length > 1 ? ` on server ${g}` : ""}`);
      });
    }
  }
  const lifetimes = all.length > 1 ? ` on each of ${all.length} servers` : "";
  return { name: "roster", pass: all.length > 0 && wrong.length === 0, detail: wrong.length === 0 ? `${logs.length} pages see all ${logs.length}${lifetimes}` : [...new Set(wrong)].slice(0, 4).join("; ") };
}

function pct(sorted: number[], q: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

/**
 * The delivery rule (owner, #95): a tick's cross-page spread over INTERP_DELAY_MS is counted and
 * reported, but fails only as a sustained problem: more than DELIVERY_SLOW_SHARE of the shared
 * ticks over DELIVERY_SLOW_MS, or any one over DELIVERY_MAX_MS. An owner run of `revive` failed on
 * 3 ticks at 101 to 111 ms while every game-state check passed: one busy browser, not the game.
 */
export const DELIVERY_SLOW_MS = 150;
export const DELIVERY_SLOW_SHARE = 0.01;
export const DELIVERY_MAX_MS = 250;

/**
 * c. Delivery: the ticks two or more pages received reached them close together (the screens
 * agree), by the delivery rule above (the count over INTERP_DELAY_MS is reported), and the server
 * never left every page more than INTERP_DELAY_MS between two ticks (a late tick: every drawn view,
 * that far behind, runs out and stalls; this one still fails at once). A gap on one page only is
 * that browser's, not the game's: it is reported and does not fail. Measured (#94): four headless
 * pages on one machine showed a few 100 to 150 ms one-page gaps, mostly on the touch-emulated
 * pages (each synthetic touch waits on the renderer: p50 24 ms against 9 ms for a mouse event),
 * none with the same pages driven by the mouse and none with two pages.
 */
export function checkDelivery(logs: PageLog[]): CheckResult {
  // By server lifetime, then tick.
  const byTick = new Map<string, number[]>();
  const tickKey = (gen: number, tick: number) => `${gen}:${tick}`;
  for (const l of logs) for (const f of l.frames) {
    const k = tickKey(f.gen, f.s.tick);
    const a = byTick.get(k);
    if (a) a.push(f.at);
    else byTick.set(k, [f.at]);
  }
  const spreads: number[] = [];
  for (const a of byTick.values()) if (a.length >= 2) spreads.push(Math.max(...a) - Math.min(...a));
  spreads.sort((x, y) => x - y);
  const over = spreads.filter((s) => s > INTERP_DELAY_MS).length;
  const slow = spreads.filter((s) => s > DELIVERY_SLOW_MS).length;
  const max = spreads[spreads.length - 1] ?? 0;
  const slowShare = spreads.length === 0 ? 0 : slow / spreads.length;
  // The server's cadence: each tick's first receipt on any page, against the tick before's, within
  // one server lifetime (the restart's own gap is reported, not late).
  const late: string[] = [];
  const lifetimes = [...new Set(logs.flatMap((l) => l.frames.map((f) => f.gen)))].sort((a, b) => a - b);
  for (const g of lifetimes) {
    const ticks = [...new Set(logs.flatMap((l) => l.frames.filter((f) => f.gen === g).map((f) => f.s.tick)))].sort((x, y) => x - y);
    for (let i = 1; i < ticks.length; i++) {
      const t = ticks[i]!;
      if (t !== ticks[i - 1]! + 1) continue;
      const gap = Math.min(...byTick.get(tickKey(g, t))!) - Math.min(...byTick.get(tickKey(g, t - 1))!);
      if (gap > INTERP_DELAY_MS) late.push(`${lifetimes.length > 1 ? `server ${g} ` : ""}tick ${t} ${ms(gap)} late`);
    }
  }
  const restartGaps: string[] = [];
  for (let i = 1; i < lifetimes.length; i++) {
    const before = Math.max(...logs.flatMap((l) => l.frames.filter((f) => f.gen === lifetimes[i - 1]).map((f) => f.at)));
    const after = Math.min(...logs.flatMap((l) => l.frames.filter((f) => f.gen === lifetimes[i]).map((f) => f.at)));
    if (Number.isFinite(before) && Number.isFinite(after)) restartGaps.push(`restart gap ${((after - before) / 1000).toFixed(1)} s (not judged)`);
  }
  const onePage: string[] = [];
  let maxGap = 0;
  for (const l of logs) {
    for (let i = 1; i < l.frames.length; i++) {
      const a = l.frames[i - 1]!;
      const b = l.frames[i]!;
      if (a.you !== b.you || a.gen !== b.gen) continue;
      const gap = b.at - a.at;
      maxGap = Math.max(maxGap, gap);
      if (gap > INTERP_DELAY_MS) onePage.push(`${l.name} (${l.touch ? "touch" : "mouse"}) ${ms(gap)} before tick ${b.s.tick}`);
    }
  }
  const pass = spreads.length > 0 && slowShare <= DELIVERY_SLOW_SHARE && max <= DELIVERY_MAX_MS && late.length === 0;
  const shown = [...late, ...onePage].slice(0, 3).join("; ");
  return {
    name: "delivery",
    pass,
    detail:
      `${spreads.length} shared ticks, spread p50 ${ms(pct(spreads, 0.5))} p95 ${ms(pct(spreads, 0.95))} max ${ms(max)} (fails above ${DELIVERY_MAX_MS} ms), ` +
      `${over} over ${INTERP_DELAY_MS} ms, ${slow} over ${DELIVERY_SLOW_MS} ms (${(slowShare * 100).toFixed(1)}%, fails above ${DELIVERY_SLOW_SHARE * 100}%); ` +
      `${late.length} ticks late from the server; ${restartGaps.length > 0 ? `${restartGaps.join(", ")}; ` : ""}longest gap on a page ${ms(maxGap)}, ${onePage.length} over ${INTERP_DELAY_MS} ms on one page only (reported, not failed)${shown ? `: ${shown}` : ""}`,
  };
}

/** What every page gets of another player's row: position, aim, alive and the flags. */
const sharedRow = (r: SnapshotPlayer): string => JSON.stringify([r[1], r[2], r[5], r[6], r[7], r[8], r[9], r[10]]);

/**
 * Positions: every player row two pages received for the same tick is the same on both (x, y,
 * aim, alive, untouchable, dashing, spawn-protected, effects), each page's own row left out (it
 * carries the page's exact `me` numbers, not the shared quantized ones).
 */
export function checkPositions(logs: PageLog[]): CheckResult {
  const byTick = new Map<string, Map<number, { row: string; page: string }>>();
  let compared = 0;
  const wrong: string[] = [];
  for (const l of logs) for (const f of l.frames) {
    const k = `${f.gen}:${f.s.tick}`;
    let rows = byTick.get(k);
    if (!rows) byTick.set(k, (rows = new Map()));
    for (const r of f.s.p) {
      if (r[0] === f.you) continue;
      const row = sharedRow(r);
      const prev = rows.get(r[0]);
      if (!prev) rows.set(r[0], { row, page: l.name });
      else if (prev.page !== l.name) {
        compared++;
        if (prev.row !== row) wrong.push(`tick ${f.s.tick} player ${r[0]}: ${prev.page} ${prev.row}, ${l.name} ${row}`);
      }
    }
  }
  return {
    name: "positions",
    pass: compared > 0 && wrong.length === 0,
    detail: wrong.length === 0 ? `${compared} player rows two pages had for the same tick, all the same` : `${wrong.length} differ: ${wrong.slice(0, 3).join("; ")}`,
  };
}

/** The first and last tick a page received from server lifetime `gen`: it was connected then. */
function span(l: PageLog, gen: number): [number, number] | null {
  const f = l.frames.filter((x) => x.gen === gen);
  return f.length === 0 ? null : [f[0]!.s.tick, f[f.length - 1]!.s.tick];
}

/**
 * d and e. Every down (and revive) any page received reached every page connected at its tick,
 * the same on each (a revive's reviver and points too), and no more than DELIVERY_MAX_MS apart
 * across pages. Spreads over INTERP_DELAY_MS and DELIVERY_SLOW_MS are counted and reported: a run
 * has a few dozen events at most, so a share rule would make one slow event a failure (#95).
 */
export function checkEvents(logs: PageLog[], kind: typeof DOWN | typeof REVIVE): CheckResult {
  const seen = new Map<string, { at: number[]; who: Set<number>; body: Set<string> }>();
  for (const l of logs) for (const e of l.events) {
    if (e.ev.kind !== kind || e.tick < 0) continue;
    const key = `${e.gen}:${e.tick}:${e.ev.id}`;
    const s = seen.get(key) ?? { at: [], who: new Set(), body: new Set() };
    s.at.push(e.at);
    s.who.add(l.index);
    s.body.add(JSON.stringify([e.ev.id, e.ev.by ?? null, e.ev.points ?? null]));
    seen.set(key, s);
  }
  const wrong: string[] = [];
  let worst = 0;
  let over = 0;
  let slow = 0;
  for (const [key, s] of seen) {
    const [gen, tick] = key.split(":").map(Number) as [number, number];
    for (const l of logs) {
      const sp = span(l, gen);
      if (sp && sp[0] < tick && tick <= sp[1] && !s.who.has(l.index)) wrong.push(`${l.name} missed ${kind} ${key}`);
    }
    if (s.body.size > 1) wrong.push(`${kind} ${key} differs: ${[...s.body].join(" vs ")}`);
    const spread = Math.max(...s.at) - Math.min(...s.at);
    worst = Math.max(worst, spread);
    if (spread > INTERP_DELAY_MS) over++;
    if (spread > DELIVERY_SLOW_MS) slow++;
    if (spread > DELIVERY_MAX_MS) wrong.push(`${kind} ${key} spread ${ms(spread)}`);
  }
  // Every life ends through a down, so a run with none saw nothing to compare.
  return {
    name: `${kind}s`,
    pass: wrong.length === 0 && (kind !== DOWN || seen.size > 0),
    detail:
      wrong.length === 0
        ? `${seen.size} ${kind}s, every page had each, spread max ${ms(worst)} (fails above ${DELIVERY_MAX_MS} ms), ${over} over ${INTERP_DELAY_MS} ms, ${slow} over ${DELIVERY_SLOW_MS} ms`
        : wrong.slice(0, 4).join("; "),
  };
}

/**
 * f. Kills: each kill (by bug id) is the same on every page whose view had it: the same tick, the
 * same scorer and the same points. Views are culled, so a kill only one page saw is not compared.
 */
export function checkKills(logs: PageLog[]): CheckResult {
  const byBug = new Map<string, { row: string; pages: number }>();
  let compared = 0;
  const wrong: string[] = [];
  for (const l of logs) for (const f of l.frames) for (const k of f.s.k) {
    const row = `${f.s.tick}:${k[1]}:${k[4]}`;
    const prev = byBug.get(`${f.gen}:${k[0]}`);
    if (!prev) byBug.set(`${f.gen}:${k[0]}`, { row, pages: 1 });
    else {
      prev.pages++;
      compared++;
      if (prev.row !== row) wrong.push(`bug ${k[0]}: ${prev.row} vs ${l.name}'s ${row} (tick:by:points)`);
    }
  }
  const shared = [...byBug.values()].filter((v) => v.pages > 1).length;
  return {
    name: "kills",
    pass: wrong.length === 0 && compared > 0,
    detail: wrong.length === 0 ? `${byBug.size} kills seen, ${shared} by two or more pages, ${compared} cross-checks agree` : `differ: ${wrong.slice(0, 4).join("; ")}`,
  };
}

/**
 * g. A page's own score (its private `me.sc`) moves by exactly what the pages saw it earn: the
 * points of the kills by its id in any page's kill rows (by bug id, so a kill two pages saw counts
 * once), its revives' points and its share of a queen's reward. Compared over each run of ticks in
 * a life (consecutive ticks with `me.al` 1). A shot reaches SHOT_RANGE, past a view's cull square,
 * so a kill can be in no page's view: a run whose seen kills fall short of its own kill count
 * (`me.ki`) is not judged, only counted.
 */
export function checkScore(logs: PageLog[]): CheckResult {
  let compared = 0;
  let unseen = 0;
  let points = 0;
  const wrong: string[] = [];
  // Every kill row any page had, by server lifetime and tick, then bug id.
  const kills = new Map<string, Map<number, SnapshotKill>>();
  for (const l of logs) for (const f of l.frames) for (const k of f.s.k) {
    const m = kills.get(`${f.gen}:${f.s.tick}`) ?? new Map<number, SnapshotKill>();
    m.set(k[0], k);
    kills.set(`${f.gen}:${f.s.tick}`, m);
  }
  // Revives and queen rewards: every page gets them; one copy of each, by server lifetime and tick.
  const bonus = new Map<string, { gen: number; tick: number; id: number; points: number }>();
  for (const l of logs) for (const e of l.events) {
    if (e.tick < 0) continue;
    if (e.ev.kind === REVIVE) bonus.set(`r${e.gen}:${e.tick}:${e.ev.id}`, { gen: e.gen, tick: e.tick, id: e.ev.by ?? 0, points: e.ev.points ?? 0 });
    else if (e.ev.kind === QUEEN) for (const [id, pts] of e.ev.paid ?? []) bonus.set(`q${e.gen}:${e.tick}:${id}`, { gen: e.gen, tick: e.tick, id, points: pts });
  }
  for (const x of logs) {
    // Runs of consecutive ticks in a life, for one id.
    const runs: FrameRec[][] = [];
    let run: FrameRec[] = [];
    for (const f of x.frames) {
      const prev = run[run.length - 1];
      if (f.s.me.al === 1 && prev && prev.you === f.you && prev.gen === f.gen && f.s.tick === prev.s.tick + 1) run.push(f);
      else {
        if (run.length >= 2) runs.push(run);
        run = f.s.me.al === 1 ? [f] : [];
      }
    }
    if (run.length >= 2) runs.push(run);
    for (const r of runs) {
      const first = r[0]!;
      const last = r[r.length - 1]!;
      const own = last.s.me.sc - first.s.me.sc;
      const ownKills = last.s.me.ki - first.s.me.ki;
      let tally = 0;
      let seen = 0;
      for (let t = first.s.tick + 1; t <= last.s.tick; t++) {
        for (const k of kills.get(`${first.gen}:${t}`)?.values() ?? []) {
          if (k[1] !== first.you) continue;
          tally += k[4];
          seen++;
        }
      }
      for (const b of bonus.values()) if (b.gen === first.gen && b.id === first.you && b.tick > first.s.tick && b.tick <= last.s.tick) tally += b.points;
      if (seen < ownKills) {
        unseen++;
        continue;
      }
      compared++;
      points += own;
      if (tally !== own || seen !== ownKills) wrong.push(`${x.name} ${first.gen > 0 ? `server ${first.gen} ` : ""}ticks ${first.s.tick}-${last.s.tick}: own ${own} (${ownKills} kills), the pages saw ${tally} (${seen} kills)`);
    }
  }
  return {
    name: "score",
    pass: compared > 0 && wrong.length === 0,
    detail:
      wrong.length === 0
        ? `${compared} life spans, ${points} points, each matched by the kills, revives and queen rewards the pages saw; ${unseen} spans with a kill no page's view had (not judged)`
        : wrong.slice(0, 4).join("; "),
  };
}

/** Smallest angle between two directions, radians. */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

/** Aim within this of what was meant, radians. */
export const AIM_TOLERANCE = 0.3;
/** A page's input check passes when this share of its samples agree. */
export const INPUT_PASS_SHARE = 0.8;
/** Ticks for the velocity to turn round from full speed: 2 MAX_SPEED at ACCEL, rounded up. */
export const MOVE_SETTLE_TICKS = Math.ceil((MAX_SPEED * 2) / (ACCEL * DT));
/** At least this many samples per page, or the check has nothing to say. */
const INPUT_MIN_SAMPLES = 20;

/**
 * h. Real input reached the server. Two links per page: what the harness dispatched (keys or
 * stick, mouse or thumb, fire) is what the page sent, and what it sent is what the server applied
 * (its own row's velocity heads along a sent move, and its aim is the sent aim, paired by `ack`).
 * Judged while the page is up (not down, not out, not dashing); aim only while firing (a touch
 * screen aims only then).
 */
export function checkInput(logs: PageLog[]): CheckResult {
  const parts: string[] = [];
  let pass = true;
  for (const l of logs) {
    let n1 = 0;
    let ok1 = 0;
    let n2 = 0;
    let ok2 = 0;
    // Link 1: intent to sent input, by the harness's clock: each input against the last intent
    // Chrome had fully taken before it was sent, skipped while the next one was being dispatched.
    let fi = 0;
    let ii = -1;
    for (const s of l.sent) {
      while (fi + 1 < l.frames.length && l.frames[fi + 1]!.hat <= s.hat) fi++;
      while (ii + 1 < l.intents.length && l.intents[ii + 1]!.done <= s.hat) ii++;
      const f = l.frames[fi];
      const it = l.intents[ii];
      const next = l.intents[ii + 1];
      if (!f || !it || (next && next.hat <= s.hat)) continue;
      if (f.s.me.al !== 1 || f.s.me.dn === 1 || f.s.me.dk > 0 || it.mode === "out" || it.mode === "down" || it.dash) continue;
      n1++;
      const m = s.msg;
      const moveOk = it.mx === 0 && it.my === 0 ? m.mx === 0 && m.my === 0 : m.mx * it.mx + m.my * it.my > 0.9 * Math.hypot(m.mx, m.my);
      const fireOk = m.fire === it.fire;
      const aimOk = !it.fire || it.aim === null || angleBetween(m.aim, it.aim) <= AIM_TOLERANCE;
      if (moveOk && fireOk && aimOk) ok1++;
    }
    // Link 2: sent input to the server's row, paired by ack within one server lifetime (seqs start again on a new socket).
    const bySeq = new Map<string, InputMessage>();
    for (const s of l.sent) bySeq.set(`${s.gen}:${s.msg.seq}`, s.msg);
    let held = 0;
    let last: InputMessage | null = null;
    for (const f of l.frames) {
      const m = bySeq.get(`${f.gen}:${f.s.ack}`);
      held = m && last && m.mx === last.mx && m.my === last.my ? held + 1 : 0;
      last = m ?? null;
      const row = rowOf(f.s.p, f.you);
      if (!m || !row || f.s.me.al !== 1 || f.s.me.dn === 1 || f.s.me.dk > 0 || row[8] === 1) continue;
      const speed = Math.hypot(row[3], row[4]);
      const moving = m.mx !== 0 || m.my !== 0;
      // A robot at a wall can't move into it; skip rows held there.
      if (moving && speed < 1) continue;
      n2++;
      const aimOk = angleBetween(row[5], m.aim) <= 0.01;
      // The velocity turns at ACCEL: a full reverse takes MOVE_SETTLE_TICKS, so a move is judged once it has held that long.
      const moveOk = !moving || held < MOVE_SETTLE_TICKS || row[3] * m.mx + row[4] * m.my > 0;
      if (aimOk && moveOk) ok2++;
    }
    const share1 = n1 === 0 ? 0 : ok1 / n1;
    const share2 = n2 === 0 ? 0 : ok2 / n2;
    const good = n1 >= INPUT_MIN_SAMPLES && n2 >= INPUT_MIN_SAMPLES && share1 >= INPUT_PASS_SHARE && share2 >= INPUT_PASS_SHARE;
    if (!good) pass = false;
    parts.push(`${l.name} ${l.touch ? "touch" : "mouse"} ${Math.round(share1 * 100)}%/${Math.round(share2 * 100)}%${good ? "" : ` (n ${n1}/${n2})`}`);
  }
  return { name: "input", pass, detail: `dispatched->sent / sent->server: ${parts.join(", ")}` };
}

/** A number as the screen writes it: "2,167.5" is 2167.5. */
export function shownNumber(text: string | null): number | null {
  if (text === null) return null;
  const d = text.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(d) ? Number(d) : null;
}

/** A life's score this far past its over event is on every top 10 read after it, if it ranks. */
export const TOP_SETTLE_MS = 2000;

/**
 * i. Life over: each page's life-over screen shows the score its over event carried; every life
 * that ranks on the top 10 is on every top 10 any page read TOP_SETTLE_MS or more after it ended
 * (its player's row there at least that score: the top 10 is each player's best); and two pages'
 * reads with no life ending between them (nor TOP_SETTLE_MS before) show the same top 10.
 */
export function checkLifeOver(logs: PageLog[]): CheckResult {
  const wrong: string[] = [];
  let screens = 0;
  let reads = 0;
  let same = 0;
  const overs = logs.flatMap((l) => l.events.filter((e) => e.ev.kind === OVER).map((e) => ({ l, e })));
  for (const l of logs) {
    const mine = l.events.filter((e) => e.ev.kind === OVER);
    for (const s of l.screens) {
      const e = mine[s.over];
      if (!e) continue;
      screens++;
      if (shownNumber(s.text) !== e.ev.score) wrong.push(`${l.name} over ${s.over} shows "${s.text}", event says ${e.ev.score}`);
    }
  }
  for (const { l, e } of overs) {
    const score = e.ev.score ?? 0;
    for (const o of logs) for (const t of o.tops) {
      if (t.at < e.at + TOP_SETTLE_MS) continue;
      const tenth = t.rows.length >= 10 ? t.rows[9]!.score : -Infinity;
      if (score <= tenth) continue;
      reads++;
      if (!t.rows.some((r) => r.name === l.name && r.score >= score)) wrong.push(`${l.name}'s ${score} missing from ${o.name}'s top 10 read`);
    }
  }
  const all = logs.flatMap((l) => l.tops.map((t) => ({ l, t }))).sort((a, b) => a.t.at - b.t.at);
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      if (a.l === b.l) continue;
      // A restart ends every life with no over event: reads from two server lifetimes are not compared.
      if (a.t.gen !== b.t.gen) continue;
      if (overs.some(({ e }) => e.at > a.t.at - TOP_SETTLE_MS && e.at <= b.t.at)) continue;
      same++;
      if (JSON.stringify(a.t.rows) !== JSON.stringify(b.t.rows)) wrong.push(`${a.l.name} and ${b.l.name} read different top 10s with no life ending between`);
    }
  }
  const pass = wrong.length === 0 && overs.length > 0 && screens > 0 && reads + same > 0;
  return {
    name: "life over",
    pass,
    detail:
      wrong.length > 0
        ? wrong.slice(0, 4).join("; ")
        : `${overs.length} lives over, ${screens} screens match their event, ${reads} later top 10 reads hold every ranking life, ${same} pairs of pages' reads agree`,
  };
}

/** The revive scenario: the victim went down and the reviver (no one else) revived it, and every page saw that revive. */
export function checkScenarioRevive(logs: PageLog[]): CheckResult {
  const victim = logs.find((l) => l.role === "victim");
  const reviver = logs.find((l) => l.role === "reviver");
  if (!victim || !reviver) return { name: "revive scenario", pass: false, detail: "no victim or reviver page" };
  const downs = victim.events.filter((e) => e.ev.kind === DOWN && e.ev.id === victim.you).length;
  const revives = victim.events.filter((e) => e.ev.kind === REVIVE && e.ev.id === victim.you);
  const revive = revives.find((e) => e.ev.by === reviver.you);
  if (!revive) {
    const by = revives.map((e) => e.ev.by).join(", ");
    return { name: "revive scenario", pass: false, detail: `${victim.name} went down ${downs} times, never revived by ${reviver.name} (id ${reviver.you})${by ? `; revived by id ${by}` : ""}` };
  }
  const missing = logs.filter((l) => !l.events.some((e) => e.ev.kind === REVIVE && e.ev.id === victim.you && e.ev.by === reviver.you && e.tick === revive.tick));
  return {
    name: "revive scenario",
    pass: missing.length === 0,
    detail: missing.length === 0 ? `${victim.name} down, revived by ${reviver.name} at tick ${revive.tick} (+${revive.ev.points}), seen by all ${logs.length}` : `not seen by ${missing.map((l) => l.name).join(", ")}`,
  };
}

/** A roster as sorted [id, name] pairs, for comparing. */
const rosterKey = (r: Map<number, string>): string => JSON.stringify([...r].sort((a, b) => a[0] - b[0]));
/** Downs by id, with their timers, for comparing. */
const downsKey = (d: SnapshotDown[]): string => JSON.stringify([...d].sort((a, b) => a[0] - b[0]));

/**
 * The late-join scenario: the late page's first snapshot (a new socket's first is a keyframe) is
 * at LATE_JOIN_WAVE or later, and at that tick its screen agrees with every early page's: the
 * roster (its welcome and the joins and leaves before that snapshot, against what the early page
 * had received by the same tick), the other players' rows and the downs (by id, with their
 * timers). Then it plays on for LATE_PLAY_S. Roster, downs, kills and score from there on are the
 * common checks, which include the late page.
 */
export function checkScenarioLateJoin(logs: PageLog[]): CheckResult {
  const name = "late-join scenario";
  const late = logs.find((l) => l.late);
  const early = logs.filter((l) => !l.late);
  if (!late) return { name, pass: false, detail: "no late page" };
  const first = late.frames[0];
  if (!first) return { name, pass: false, detail: `${late.name} never got a snapshot (no wave ${LATE_JOIN_WAVE} seen in time, or it never joined)` };
  const tick = first.s.tick;
  const wrong: string[] = [];
  if (first.s.w < LATE_JOIN_WAVE) wrong.push(`${late.name}'s first snapshot is at wave ${first.s.w}, not ${LATE_JOIN_WAVE}`);
  const mine = rosterAt(late, first.at);
  let rows = 0;
  for (const e of early) {
    const f = e.frames.find((x) => x.s.tick === tick);
    if (!f) {
      wrong.push(`${e.name} has no tick ${tick}`);
      continue;
    }
    const theirs = rosterAt(e, f.at);
    if (rosterKey(mine) !== rosterKey(theirs)) wrong.push(`roster: ${late.name} ${rosterKey(mine)}, ${e.name} ${rosterKey(theirs)}`);
    // Each page's own row carries its exact numbers, so both pages' own rows are left out.
    const others = (fr: FrameRec) => new Map(fr.s.p.filter((r) => r[0] !== late.you && r[0] !== e.you).map((r) => [r[0], sharedRow(r)]));
    const a = others(first);
    const b = others(f);
    if (a.size !== b.size || [...a].some(([id, row]) => b.get(id) !== row)) wrong.push(`players at tick ${tick}: ${late.name} and ${e.name} differ`);
    rows += a.size;
    if (downsKey(first.s.d) !== downsKey(f.s.d)) wrong.push(`downs at tick ${tick}: ${late.name} ${downsKey(first.s.d)}, ${e.name} ${downsKey(f.s.d)}`);
  }
  const playedS = (late.frames[late.frames.length - 1]!.s.tick - tick) * DT;
  if (playedS < LATE_PLAY_S) wrong.push(`${late.name} played ${playedS.toFixed(1)} s after joining, under ${LATE_PLAY_S}`);
  return {
    name,
    pass: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `${late.name} joined at wave ${first.s.w}, first snapshot tick ${tick} (${(tick * DT).toFixed(1)} s in): roster of ${mine.size}, ${rows} player rows and ${first.s.d.length} downs the same as on all ${early.length} early pages; then ${playedS.toFixed(1)} s of play`
        : wrong.slice(0, 4).join("; "),
  };
}

/**
 * What the harness saw of the restart: the old server's PID and how it stopped (`graceful`: it
 * exited on its own after the IPC shutdown, with `code`, `ms` after it was asked), the new one's
 * PID, and the old server's shutdown log line (its lives saved), if it printed one.
 */
export type RestartReport = { pid0: number; pid1: number; code: number | null; ms: number; graceful: boolean; logLine: string | null };

/**
 * The restart scenario: the old server stopped through its graceful path (it exited 0 on its own
 * within the shutdown budget after the IPC message), every page was told `restarting` by it, then
 * rejoined: exactly one new welcome from the new server, on the same build (not "Updating..."),
 * and played on for AFTER_RESTART_S (less 5 s of slack) with inputs sent. The common checks run
 * per server lifetime (`gen`).
 */
export function checkScenarioRestart(logs: PageLog[], r: RestartReport | null, budgetMs: number): CheckResult {
  const name = "restart scenario";
  if (!r) return { name, pass: false, detail: "the server was never restarted" };
  const wrong: string[] = [];
  if (!r.graceful || r.code !== 0 || r.ms > budgetMs) wrong.push(`server ${r.pid0} stopped ${r.graceful ? "" : "by a kill, "}with exit ${r.code} after ${Math.round(r.ms)} ms (budget ${budgetMs} ms)`);
  const rejoin: string[] = [];
  for (const l of logs) {
    if (!l.errors.some((e) => e.gen === 0 && e.code === ERROR_RESTARTING)) wrong.push(`${l.name} was never told restarting`);
    const old = l.welcomes.filter((w) => w.gen === 0);
    const fresh = l.welcomes.filter((w) => w.gen === 1);
    if (fresh.length !== 1) {
      wrong.push(`${l.name} has ${fresh.length} welcomes from the new server, not 1`);
      continue;
    }
    if (old.length > 0 && fresh[0]!.build !== old[0]!.build) wrong.push(`${l.name} rejoined build ${fresh[0]!.build}, not ${old[0]!.build}`);
    const f = l.frames.filter((x) => x.gen === 1);
    const played = f.length === 0 ? 0 : (f[f.length - 1]!.s.tick - f[0]!.s.tick) * DT;
    const sent = l.sent.filter((x) => x.gen === 1).length;
    if (played < AFTER_RESTART_S - 5 || sent === 0) wrong.push(`${l.name} played ${played.toFixed(1)} s on the new server with ${sent} inputs`);
    const told = l.errors.find((e) => e.gen === 0 && e.code === ERROR_RESTARTING);
    rejoin.push(`${l.name} ${told ? `${((fresh[0]!.at - told.at) / 1000).toFixed(1)} s` : "?"}`);
  }
  return {
    name,
    pass: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `server ${r.pid0} stopped gracefully (exit 0, ${Math.round(r.ms)} ms${r.logLine ? `, "${r.logLine}"` : ""}), server ${r.pid1} took over; all ${logs.length} told restarting, each rejoined once on the same build (told to welcome: ${rejoin.join(", ")}) and played on`
        : wrong.slice(0, 4).join("; "),
  };
}

/** A page's id at a tick of server lifetime `gen`: its frame's there, else its last welcome in that lifetime (0: none). */
function idAt(l: PageLog, gen: number, tick: number): number {
  const f = l.frames.find((x) => x.gen === gen && x.s.tick === tick);
  if (f) return f.you;
  return l.welcomes.filter((w) => w.gen === gen).at(-1)?.you ?? 0;
}

/**
 * The queen scenario (#96), her state: every tick two or more pages received carries the same `q`
 * on each (decoded, so her marker's ticks left too), and they shared at least one tick of her
 * marker and one of her alive. Pages that joined after her marker are not required to have seen it.
 */
export function checkQueenSnapshots(logs: PageLog[]): CheckResult {
  const name = "queen q";
  const byTick = new Map<string, { gen: number; tick: number; seen: { page: string; q: string }[] }>();
  for (const l of logs) for (const f of l.frames) {
    const k = `${f.gen}:${f.s.tick}`;
    const a = byTick.get(k) ?? { gen: f.gen, tick: f.s.tick, seen: [] };
    a.seen.push({ page: l.name, q: JSON.stringify(f.s.q) });
    byTick.set(k, a);
  }
  const wrong: string[] = [];
  const shared = { none: 0, marker: 0, alive: 0 };
  let hpFirst: number | null = null;
  let hpLast: number | null = null;
  let hpMax: number | null = null;
  const ticks = [...byTick.values()].sort((a, b) => a.gen - b.gen || a.tick - b.tick);
  for (const { tick, seen } of ticks) {
    if (seen.length < 2) continue;
    const first = seen[0]!;
    const other = seen.find((x) => x.q !== first.q);
    if (other) {
      wrong.push(`tick ${tick}: ${first.page} ${first.q}, ${other.page} ${other.q}`);
      continue;
    }
    const q = JSON.parse(first.q) as SnapshotQueen;
    if (q.length === 0) shared.none++;
    else if (q[0] === 0) shared.marker++;
    else {
      shared.alive++;
      hpFirst ??= q[4];
      hpLast = q[4];
      hpMax = q[5];
    }
  }
  if (wrong.length > 0) return { name, pass: false, detail: `${wrong.length} ticks differ: ${wrong.slice(0, 3).join("; ")}` };
  const total = shared.none + shared.marker + shared.alive;
  const counts = `${total} shared ticks agree: ${shared.marker} marker, ${shared.alive} alive${hpMax !== null ? ` (hp from ${hpFirst} to ${hpLast} of ${hpMax})` : ""}, ${shared.none} none`;
  if (shared.marker === 0) return { name, pass: false, detail: `${counts}; no two pages shared a tick of her marker (they joined after it: use --serve, or an empty server)` };
  if (shared.alive === 0) return { name, pass: false, detail: `${counts}; no two pages shared a tick of her alive` };
  return { name, pass: true, detail: counts };
}

/**
 * The queen scenario: her `queen` event (top damage dealer, `paid`) reached every page connected
 * at its tick, the same on each, no more than DELIVERY_MAX_MS apart across pages (the counts over
 * INTERP_DELAY_MS and DELIVERY_SLOW_MS are reported), and at least one page was paid: it damaged her.
 */
export function checkQueenEvent(logs: PageLog[]): CheckResult {
  const name = "queen event";
  const seen = new Map<string, { gen: number; tick: number; at: number[]; who: Set<number>; body: Set<string> }>();
  for (const l of logs) for (const e of l.events) {
    if (e.ev.kind !== QUEEN || e.tick < 0) continue;
    const key = `${e.gen}:${e.tick}`;
    const s = seen.get(key) ?? { gen: e.gen, tick: e.tick, at: [], who: new Set(), body: new Set() };
    s.at.push(e.at);
    s.who.add(l.index);
    s.body.add(JSON.stringify([e.ev.id ?? 0, [...(e.ev.paid ?? [])].sort((a, b) => a[0] - b[0])]));
    seen.set(key, s);
  }
  if (seen.size === 0) return { name, pass: false, detail: "no page had a queen event: she was never killed" };
  const wrong: string[] = [];
  const parts: string[] = [];
  let worst = 0;
  let over = 0;
  let slow = 0;
  let paidPages = 0;
  for (const { gen, tick, at, who, body } of seen.values()) {
    for (const l of logs) {
      const sp = span(l, gen);
      if (sp && sp[0] < tick && tick <= sp[1] && !who.has(l.index)) wrong.push(`${l.name} missed the queen event at tick ${tick}`);
    }
    if (body.size > 1) wrong.push(`the queen event at tick ${tick} differs: ${[...body].join(" vs ")}`);
    const spread = Math.max(...at) - Math.min(...at);
    worst = Math.max(worst, spread);
    if (spread > INTERP_DELAY_MS) over++;
    if (spread > DELIVERY_SLOW_MS) slow++;
    if (spread > DELIVERY_MAX_MS) wrong.push(`the queen event at tick ${tick} spread ${ms(spread)}`);
    const [top, paid] = JSON.parse([...body][0]!) as [number, [number, number][]];
    const nameOf = (id: number) => logs.find((l) => idAt(l, gen, tick) === id)?.name ?? null;
    const paidNames = paid.map(([id]) => nameOf(id)).filter((n): n is string => n !== null);
    paidPages += paidNames.length;
    parts.push(`tick ${tick}: ${top === 0 ? "nobody" : (nameOf(top) ?? "a fill bot")} dealt the most; ${paid.length} paid${paidNames.length > 0 ? ` (${paidNames.join(", ")})` : ""}; on ${who.size} pages`);
  }
  if (paidPages === 0) wrong.push("no page was paid: none of them damaged her");
  return {
    name,
    pass: wrong.length === 0,
    detail:
      wrong.length === 0
        ? `${parts.join("; ")}; spread max ${ms(worst)} (fails above ${DELIVERY_MAX_MS} ms), ${over} over ${INTERP_DELAY_MS} ms, ${slow} over ${DELIVERY_SLOW_MS} ms`
        : wrong.slice(0, 4).join("; "),
  };
}

/**
 * The queen scenario: each paid page's own score (`me.sc`) moved at her kill tick by exactly its
 * `paid` points plus that tick's kills by it (any page's kill rows, by bug id) and revives by it
 * (her reward is paid in the step that kills her, payQueen). The score check skips a whole life
 * span with a kill no view had, so this one reads the kill tick alone, and needs one paid page
 * judged. A page with no frame at the tick before and at it, or a kill there no view had, is not judged.
 */
export function checkQueenPay(logs: PageLog[]): CheckResult {
  const name = "queen pay";
  const events = new Map<string, { gen: number; tick: number; paid: [number, number][] }>();
  for (const l of logs) for (const e of l.events) {
    if (e.ev.kind === QUEEN && e.tick >= 0) events.set(`${e.gen}:${e.tick}`, { gen: e.gen, tick: e.tick, paid: e.ev.paid ?? [] });
  }
  if (events.size === 0) return { name, pass: false, detail: "no queen event: nothing paid to check" };
  const wrong: string[] = [];
  const ok: string[] = [];
  let unjudged = 0;
  for (const { gen, tick, paid } of events.values()) {
    const kills = new Map<number, SnapshotKill>();
    for (const l of logs) for (const f of l.frames) if (f.gen === gen && f.s.tick === tick) for (const k of f.s.k) kills.set(k[0], k);
    const revives = new Map<number, { by: number; points: number }>();
    for (const l of logs) for (const e of l.events) if (e.ev.kind === REVIVE && e.gen === gen && e.tick === tick) revives.set(e.ev.id, { by: e.ev.by ?? 0, points: e.ev.points ?? 0 });
    for (const [id, pts] of paid) {
      const l = logs.find((x) => idAt(x, gen, tick) === id);
      if (!l) continue;
      const before = l.frames.find((f) => f.gen === gen && f.s.tick === tick - 1 && f.you === id);
      const now = l.frames.find((f) => f.gen === gen && f.s.tick === tick && f.you === id);
      if (!before || !now) {
        unjudged++;
        continue;
      }
      let killPts = 0;
      let seenKills = 0;
      for (const k of kills.values()) {
        if (k[1] !== id) continue;
        killPts += k[4];
        seenKills++;
      }
      if (now.s.me.ki - before.s.me.ki > seenKills) {
        unjudged++;
        continue;
      }
      let revivePts = 0;
      for (const r of revives.values()) if (r.by === id) revivePts += r.points;
      const own = now.s.me.sc - before.s.me.sc;
      const expected = pts + killPts + revivePts;
      if (own !== expected) wrong.push(`${l.name} at tick ${tick}: own score +${own}, expected +${expected} (paid ${pts}, kills ${killPts}, revives ${revivePts})`);
      else ok.push(`${l.name} +${pts}`);
    }
  }
  if (wrong.length > 0) return { name, pass: false, detail: wrong.slice(0, 4).join("; ") };
  if (ok.length === 0) return { name, pass: false, detail: `no paid page could be judged at the kill tick (${unjudged} not judged: a frame missing, or a kill no view had)` };
  return { name, pass: true, detail: `${ok.length} paid pages' own scores moved by their pay at the kill tick (${ok.join(", ")}); ${unjudged} not judged` };
}

/** Every check for a scenario, in table order. */
export function runChecks(logs: PageLog[], scenario: ScenarioName, restart: { report: RestartReport | null; budgetMs: number } | null = null): CheckResult[] {
  const out = [checkSameArena(logs), checkRoster(logs), checkDelivery(logs), checkPositions(logs), checkEvents(logs, DOWN), checkEvents(logs, REVIVE), checkKills(logs), checkScore(logs), checkInput(logs), checkLifeOver(logs)];
  if (scenario === "revive") out.push(checkScenarioRevive(logs));
  if (scenario === "late-join") out.push(checkScenarioLateJoin(logs));
  if (scenario === "restart") out.push(checkScenarioRestart(logs, restart?.report ?? null, restart?.budgetMs ?? 0));
  if (scenario === "queen") out.push(checkQueenSnapshots(logs), checkQueenEvent(logs), checkQueenPay(logs));
  return out;
}

/** The pass/fail table. */
export function table(results: CheckResult[]): string {
  const w = Math.max(5, ...results.map((r) => r.name.length));
  const lines = [`${"check".padEnd(w)}  result  detail`, `${"-".repeat(w)}  ------  ------`];
  for (const r of results) lines.push(`${r.name.padEnd(w)}  ${r.pass ? "pass  " : "FAIL  "}  ${r.detail}`);
  return lines.join("\n");
}

export const exitCode = (results: CheckResult[]): number => (results.every((r) => r.pass) ? 0 : 1);
