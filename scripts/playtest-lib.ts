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
// Every page gets every player and every down, built from one quantized frame per tick (view.ts),
// so the players' rows are equal by construction and are not a check.
import { join } from "node:path";
import { ACCEL, DT, FILL_TARGET, INTERP_DELAY_MS, MAX_SPEED, REVIVE_RANGE, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import {
  DOWN,
  EVENT,
  INPUT,
  JOIN,
  LEAVE,
  OVER,
  REVIVE,
  SNAPSHOT,
  QUEEN,
  WELCOME,
  type ArenaEvent,
  type ServerMessage,
  type InputMessage,
  type RosterEntry,
  type SnapshotBug,
  type SnapshotDown,
  type SnapshotKill,
  type SnapshotMe,
  type SnapshotPlayer,
} from "../src/shared/arena/protocol";
import { createRng, nextRandom, type Rng } from "../src/shared/arena/rng";
import { NAME_MAX, TEAMS, type Team } from "../src/server/rules";
import { CAMERA_SECONDS, createCamera, snapCamera, type Camera } from "../src/web/arena/camera";
import { dashButtonAt } from "../src/web/arena/controls";
import { STICK_DEAD, STICK_RANGE } from "../src/web/game/stick";
import type { TopRow } from "../src/web/api";

export const USAGE = "usage: bun run playtest -- --url <base url> [--players 4] [--seconds 90] [--scenario basic|revive] [--chrome <path>] [--headed]";

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

/** Follow-up issues for the scenarios this pull request does not build. */
export const LATE_JOIN_RESTART_ISSUE = 95;
export const QUEEN_ISSUE = 96;

export const SCENARIOS: Record<ScenarioName, Scenario> = {
  basic: { name: "basic", followUp: null, why: "", minPlayers: 2, roles: (n) => Array.from({ length: n }, () => "fighter") },
  // With fewer than FILL_TARGET people the arena gets fill bots, and a bot can revive the victim.
  revive: {
    name: "revive",
    followUp: null,
    why: "",
    minPlayers: FILL_TARGET,
    roles: (n) => Array.from({ length: n }, (_, i): Role => (i === 0 ? "victim" : i === 1 ? "reviver" : "keepaway")),
  },
  "late-join": { name: "late-join", followUp: LATE_JOIN_RESTART_ISSUE, why: "a page joining at wave 6", minPlayers: 2, roles: () => [] },
  restart: { name: "restart", followUp: LATE_JOIN_RESTART_ISSUE, why: "needs the playtest to own the server process", minPlayers: 2, roles: () => [] },
  queen: { name: "queen", followUp: QUEEN_ISSUE, why: "a queen check and a run to wave 5", minPlayers: 2, roles: () => [] },
};

// ---- Arguments ----

export type PlaytestArgs = { url: string; players: number; seconds: number; scenario: ScenarioName; chrome: string | null; headed: boolean };

const INT_FLAGS = {
  players: { def: 4, min: 2, max: 20 },
  seconds: { def: 90, min: 10, max: 3600 },
} as const;

/** Parses `--url`, `--players`, `--seconds`, `--scenario`, `--chrome` (`--x v` or `--x=v`) and `--headed`. Throws a message on anything else. */
export function parseArgs(argv: string[]): PlaytestArgs {
  const seen: Record<string, string> = {};
  const args = argv.filter((a) => a !== "--");
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unexpected argument "${arg}"`);
    const key = m[1]!;
    if (key === "headed") {
      if (m[2] !== undefined) throw new Error("--headed takes no value");
      seen.headed = "1";
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
  if (seen.url === undefined) throw new Error("--url is required");
  let url: URL;
  try {
    url = new URL(seen.url);
  } catch {
    throw new Error(`--url "${seen.url}" is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--url must be http or https");
  const scenario = seen.scenario ?? "basic";
  if (!(SCENARIO_NAMES as readonly string[]).includes(scenario)) throw new Error(`--scenario must be one of ${SCENARIO_NAMES.join(", ")}`);
  const int = (key: keyof typeof INT_FLAGS): number => {
    const f = INT_FLAGS[key];
    if (seen[key] === undefined) return f.def;
    const n = Number(seen[key]);
    if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`--${key} must be a whole number from ${f.min} to ${f.max}`);
    return n;
  };
  return {
    url: url.href.replace(/\/+$/, ""),
    players: int("players"),
    seconds: int("seconds"),
    scenario: scenario as ScenarioName,
    chrome: seen.chrome ?? null,
    headed: seen.headed === "1",
  };
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

export type PageSpec = { index: number; name: string; team: Team; device: Device; role: Role; seed: number };

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
  }));
}

// ---- Recording ----

/** A snapshot as kept: what the checks read (the bugs, shots and floor are dropped to save memory). */
export type Kept = { tick: number; ack: number; p: SnapshotPlayer[]; k: SnapshotKill[]; d: SnapshotDown[]; w: number; me: SnapshotMe };
/** `at`: Chrome's receipt time, ms; `hat`: the harness's clock when it heard, ms; `you`: the page's id then. */
export type FrameRec = { at: number; hat: number; you: number; s: Kept };
/** An event, with the tick whose step raised it (the server sends a step's events before its snapshot). */
export type EventRec = { at: number; tick: number; you: number; ev: ArenaEvent };
export type WelcomeRec = { at: number; you: number; arena: number; build: string; roster: RosterEntry[] };
export type TopRec = { at: number; rows: TopRow[] };
/** An input the page sent, at the harness's clock. */
export type SentRec = { hat: number; msg: InputMessage };
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
  /** The page's id now (0 until a player welcome; a watching welcome is `you: 0`). */
  you: number;
  welcomes: WelcomeRec[];
  frames: FrameRec[];
  events: EventRec[];
  tops: TopRec[];
  sent: SentRec[];
  intents: IntentRec[];
  screens: ScreenRec[];
};

export function createLog(spec: PageSpec): PageLog {
  return { index: spec.index, name: spec.name, team: spec.team, touch: spec.device.touch, role: spec.role, you: 0, welcomes: [], frames: [], events: [], tops: [], sent: [], intents: [], screens: [] };
}

/**
 * Records one message the page received, decoded as the page decodes it (protocol.ts
 * parseServerMessage, then that socket's view.ts createSnapshotReader; null: a delta it could not
 * apply, which the page drops too). Messages before its first player welcome (the start screen's
 * watching socket) are skipped.
 */
export function addFrame(log: PageLog, at: number, hat: number, m: ServerMessage | null): void {
  if (!m) return;
  if (m.t === WELCOME) {
    if (m.you !== 0) {
      log.you = m.you;
      log.welcomes.push({ at, you: m.you, arena: m.arena, build: m.build, roster: m.roster });
    } else log.you = 0;
    return;
  }
  if (log.you === 0) return;
  if (m.t === SNAPSHOT) {
    log.frames.push({ at, hat, you: log.you, s: { tick: m.tick, ack: m.ack, p: m.p, k: m.k, d: m.d, w: m.w, me: m.me } });
  } else if (m.t === EVENT) {
    const last = log.frames[log.frames.length - 1];
    const sinceWelcome = last && last.at >= log.welcomes[log.welcomes.length - 1]!.at;
    log.events.push({ at, tick: sinceWelcome ? last.s.tick + 1 : -1, you: log.you, ev: m });
  }
}

/** Records an input the page sent (other frames it sent are ignored). */
export function addSent(log: PageLog, hat: number, raw: string): void {
  if (log.you === 0) return;
  try {
    const m = JSON.parse(raw) as InputMessage;
    if (m && m.t === INPUT) log.sent.push({ hat, msg: m });
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
};

export function createPlan(role: Role, seed: number): Plan {
  return { role, rng: createRng(seed), firing: false, burstUntil: 0, wander: { x: WORLD_W / 2, y: WORLD_H / 2 }, wanderUntil: 0, giveUp: false, partner: 0, strafe: 1 };
}

/** What a page sees: its own row and numbers, every bug and player in the arena, who is down, and its camera's view. */
export type View = {
  you: number;
  me: SnapshotPlayer | null;
  nums: SnapshotMe;
  players: SnapshotPlayer[];
  bugs: SnapshotBug[];
  downs: SnapshotDown[];
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
 * the victim.
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

  const aim = seen ? Math.atan2(seen.b[3] - y, seen.b[2] - x) : null;
  const fire = seen ? burst(plan, t) : false;

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

/** The id-to-name roster a page knows at the end: its last welcome's roster, then joins and leaves after it. */
export function rosterOf(log: PageLog): Map<number, string> {
  const out = new Map<number, string>();
  const w = log.welcomes[log.welcomes.length - 1];
  if (!w) return out;
  for (const r of w.roster) out.set(r.id, r.name);
  for (const e of log.events) {
    if (e.at < w.at) continue;
    if (e.ev.kind === JOIN) out.set(e.ev.id, e.ev.name ?? "");
    else if (e.ev.kind === LEAVE) out.delete(e.ev.id);
  }
  return out;
}

/** a. Every page joined the same arena. */
export function checkSameArena(logs: PageLog[]): CheckResult {
  const arenas = logs.map((l) => l.welcomes[0]?.arena ?? null);
  const missing = logs.filter((l) => l.welcomes.length === 0).map((l) => l.name);
  const distinct = new Set(arenas);
  const pass = missing.length === 0 && distinct.size === 1;
  return { name: "same arena", pass, detail: missing.length > 0 ? `never joined: ${missing.join(", ")}` : pass ? `arena ${arenas[0]}` : `arenas ${arenas.join(", ")}` };
}

/** b. At the end every page's roster holds every page, by id and name. */
export function checkRoster(logs: PageLog[]): CheckResult {
  const wrong: string[] = [];
  for (const l of logs) {
    const r = rosterOf(l);
    for (const o of logs) if (o.you !== 0 && r.get(o.you) !== o.name) wrong.push(`${l.name} lacks ${o.name}`);
  }
  return { name: "roster", pass: wrong.length === 0 && logs.every((l) => l.you !== 0), detail: wrong.length === 0 ? `${logs.length} pages see all ${logs.length}` : wrong.slice(0, 4).join("; ") };
}

function pct(sorted: number[], q: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

const ms = (n: number) => `${n.toFixed(1)} ms`;

/**
 * c. Delivery: every tick two or more pages received reached them within INTERP_DELAY_MS of each
 * other (the screens agree), and the server never left every page more than INTERP_DELAY_MS
 * between two ticks (a late tick: every drawn view, that far behind, runs out and stalls). A gap on
 * one page only is that browser's, not the game's: it is reported and does not fail. Measured
 * (#94): four headless pages on one machine showed a few 100 to 150 ms one-page gaps, mostly on the
 * touch-emulated pages (each synthetic touch waits on the renderer: p50 24 ms against 9 ms for a
 * mouse event), none with the same pages driven by the mouse and none with two pages.
 */
export function checkDelivery(logs: PageLog[]): CheckResult {
  const byTick = new Map<number, number[]>();
  for (const l of logs) for (const f of l.frames) {
    const a = byTick.get(f.s.tick);
    if (a) a.push(f.at);
    else byTick.set(f.s.tick, [f.at]);
  }
  const spreads: number[] = [];
  for (const a of byTick.values()) if (a.length >= 2) spreads.push(Math.max(...a) - Math.min(...a));
  spreads.sort((x, y) => x - y);
  const over = spreads.filter((s) => s > INTERP_DELAY_MS).length;
  // The server's cadence: each tick's first receipt on any page, against the tick before's.
  const ticks = [...byTick.keys()].sort((x, y) => x - y);
  const late: string[] = [];
  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i]!;
    if (t !== ticks[i - 1]! + 1) continue;
    const gap = Math.min(...byTick.get(t)!) - Math.min(...byTick.get(t - 1)!);
    if (gap > INTERP_DELAY_MS) late.push(`tick ${t} ${ms(gap)} late`);
  }
  const onePage: string[] = [];
  let maxGap = 0;
  for (const l of logs) {
    for (let i = 1; i < l.frames.length; i++) {
      const a = l.frames[i - 1]!;
      const b = l.frames[i]!;
      if (a.you !== b.you) continue;
      const gap = b.at - a.at;
      maxGap = Math.max(maxGap, gap);
      if (gap > INTERP_DELAY_MS) onePage.push(`${l.name} (${l.touch ? "touch" : "mouse"}) ${ms(gap)} before tick ${b.s.tick}`);
    }
  }
  const pass = spreads.length > 0 && over === 0 && late.length === 0;
  const shown = [...late, ...onePage].slice(0, 3).join("; ");
  return {
    name: "delivery",
    pass,
    detail:
      `${spreads.length} shared ticks, spread p50 ${ms(pct(spreads, 0.5))} p95 ${ms(pct(spreads, 0.95))} max ${ms(spreads[spreads.length - 1] ?? 0)}, ${over} over ${INTERP_DELAY_MS} ms; ` +
      `${late.length} ticks late from the server; longest gap on a page ${ms(maxGap)}, ${onePage.length} over ${INTERP_DELAY_MS} ms on one page only (reported, not failed)${shown ? `: ${shown}` : ""}`,
  };
}

/** The first and last tick a page received for its current id: it was connected then. */
function span(l: PageLog): [number, number] | null {
  const f = l.frames;
  return f.length === 0 ? null : [f[0]!.s.tick, f[f.length - 1]!.s.tick];
}

/**
 * d and e. Every down (and revive) any page received reached every page connected at its tick,
 * the same on each (a revive's reviver and points too), within INTERP_DELAY_MS of each other.
 */
export function checkEvents(logs: PageLog[], kind: typeof DOWN | typeof REVIVE): CheckResult {
  const seen = new Map<string, { at: number[]; who: Set<number>; body: Set<string> }>();
  for (const l of logs) for (const e of l.events) {
    if (e.ev.kind !== kind || e.tick < 0) continue;
    const key = `${e.tick}:${e.ev.id}`;
    const s = seen.get(key) ?? { at: [], who: new Set(), body: new Set() };
    s.at.push(e.at);
    s.who.add(l.index);
    s.body.add(JSON.stringify([e.ev.id, e.ev.by ?? null, e.ev.points ?? null]));
    seen.set(key, s);
  }
  const wrong: string[] = [];
  let worst = 0;
  for (const [key, s] of seen) {
    const tick = Number(key.split(":")[0]);
    for (const l of logs) {
      const sp = span(l);
      if (sp && sp[0] < tick && tick <= sp[1] && !s.who.has(l.index)) wrong.push(`${l.name} missed ${kind} ${key}`);
    }
    if (s.body.size > 1) wrong.push(`${kind} ${key} differs: ${[...s.body].join(" vs ")}`);
    const spread = Math.max(...s.at) - Math.min(...s.at);
    worst = Math.max(worst, spread);
    if (spread > INTERP_DELAY_MS) wrong.push(`${kind} ${key} spread ${ms(spread)}`);
  }
  // Every life ends through a down, so a run with none saw nothing to compare.
  return {
    name: `${kind}s`,
    pass: wrong.length === 0 && (kind !== DOWN || seen.size > 0),
    detail: wrong.length === 0 ? `${seen.size} ${kind}s, every page had each, spread max ${ms(worst)}` : wrong.slice(0, 4).join("; "),
  };
}

/**
 * f. Kills: each kill (by bug id) is the same on every page whose view had it: the same tick, the
 * same scorer and the same points. Views are culled, so a kill only one page saw is not compared.
 */
export function checkKills(logs: PageLog[]): CheckResult {
  const byBug = new Map<number, { row: string; pages: number }>();
  let compared = 0;
  const wrong: string[] = [];
  for (const l of logs) for (const f of l.frames) for (const k of f.s.k) {
    const row = `${f.s.tick}:${k[1]}:${k[4]}`;
    const prev = byBug.get(k[0]);
    if (!prev) byBug.set(k[0], { row, pages: 1 });
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
  // Every kill row any page had, by tick, then bug id.
  const kills = new Map<number, Map<number, SnapshotKill>>();
  for (const l of logs) for (const f of l.frames) for (const k of f.s.k) {
    const m = kills.get(f.s.tick) ?? new Map<number, SnapshotKill>();
    m.set(k[0], k);
    kills.set(f.s.tick, m);
  }
  // Revives and queen rewards: every page gets them; one copy of each, by tick.
  const bonus = new Map<string, { tick: number; id: number; points: number }>();
  for (const l of logs) for (const e of l.events) {
    if (e.tick < 0) continue;
    if (e.ev.kind === REVIVE) bonus.set(`r${e.tick}:${e.ev.id}`, { tick: e.tick, id: e.ev.by ?? 0, points: e.ev.points ?? 0 });
    else if (e.ev.kind === QUEEN) for (const [id, pts] of e.ev.paid ?? []) bonus.set(`q${e.tick}:${id}`, { tick: e.tick, id, points: pts });
  }
  for (const x of logs) {
    // Runs of consecutive ticks in a life, for one id.
    const runs: FrameRec[][] = [];
    let run: FrameRec[] = [];
    for (const f of x.frames) {
      const prev = run[run.length - 1];
      if (f.s.me.al === 1 && prev && prev.you === f.you && f.s.tick === prev.s.tick + 1) run.push(f);
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
        for (const k of kills.get(t)?.values() ?? []) {
          if (k[1] !== first.you) continue;
          tally += k[4];
          seen++;
        }
      }
      for (const b of bonus.values()) if (b.id === first.you && b.tick > first.s.tick && b.tick <= last.s.tick) tally += b.points;
      if (seen < ownKills) {
        unseen++;
        continue;
      }
      compared++;
      points += own;
      if (tally !== own || seen !== ownKills) wrong.push(`${x.name} ticks ${first.s.tick}-${last.s.tick}: own ${own} (${ownKills} kills), the pages saw ${tally} (${seen} kills)`);
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
    // Link 2: sent input to the server's row, paired by ack.
    const bySeq = new Map<number, InputMessage>();
    for (const s of l.sent) bySeq.set(s.msg.seq, s.msg);
    let held = 0;
    let last: InputMessage | null = null;
    for (const f of l.frames) {
      const m = bySeq.get(f.s.ack);
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

/** Every check for a scenario, in table order. */
export function runChecks(logs: PageLog[], scenario: ScenarioName): CheckResult[] {
  const out = [checkSameArena(logs), checkRoster(logs), checkDelivery(logs), checkEvents(logs, DOWN), checkEvents(logs, REVIVE), checkKills(logs), checkScore(logs), checkInput(logs), checkLifeOver(logs)];
  if (scenario === "revive") out.push(checkScenarioRevive(logs));
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
