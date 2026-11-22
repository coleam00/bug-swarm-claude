// The arena's WebSocket protocol (release 2): JSON text frames, each an object whose `t` names
// its type. One validator, `parseClientMessage`, is the only way the server reads a client
// message: anything malformed, unknown or over MAX_CLIENT_MESSAGE_BYTES is dropped (null). The
// validator rejects junk only; the simulation still clamps what it accepts (sim.ts clampInput).
import { DOWN_TICKS, MAX_CLIENT_MESSAGE_BYTES, REVIVE_TICKS, TICK_MS } from "./constants";

/** Client to server. */
export const CLIENT_TYPES = ["hello", "input"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const [HELLO, INPUT] = CLIENT_TYPES;

/** Server to client. */
export const SERVER_TYPES = ["welcome", "snapshot", "event", "error"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];
export const [WELCOME, SNAPSHOT, EVENT, ERROR] = SERVER_TYPES;

/**
 * What an `event` reports: a join, a leave, your life being over (sent to you only), a player
 * going down, a revive (who, by whom, the points; both v4), a pickup taken (who, and the pickup's
 * index in PICKUP_IDS) and a test shield blocking a hit (whose; both v7). Hits, kills and shots
 * travel in snapshots, and so do who is down now (`d`) and the pickups on the floor (`f`), for a
 * late joiner.
 */
export const EVENT_KINDS = ["join", "leave", "over", "down", "revive", "pickup", "block"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const [JOIN, LEAVE, OVER, DOWN, REVIVE, PICKUP, BLOCK] = EVENT_KINDS;

/**
 * Why the server closed the socket: a refused hello (version, name, team, no hello in time, or a
 * rejoin from a page of another build: reload), or the server stopping for a redeploy
 * (restarting: reconnect). The socket closes after each.
 */
export const ERROR_CODES = ["version", "name", "team", "hello", "restarting", "build"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const [ERROR_VERSION, ERROR_NAME, ERROR_TEAM, ERROR_HELLO, ERROR_RESTARTING, ERROR_BUILD] = ERROR_CODES;

/** The longest name a hello may carry before the server's name rules (rules.ts) even look at it. */
export const HELLO_NAME_MAX = 64;
/** The largest input sequence number. */
export const MAX_SEQ = 2 ** 31 - 1;
const PLAYER_ID = /^[0-9a-f]{32}$/;

export type Hello = {
  t: typeof HELLO;
  /** PROTOCOL_VERSION the client speaks. Any whole number parses; the server decides. */
  v: number;
  name: string;
  /** Checked against TEAMS by the server. */
  team: string;
  /** The browser's 32-hex player id (player.ts). Never sent to other players. */
  player: string;
  touch: boolean;
  /**
   * The build id of the page's first welcome, on a rejoin ("" on a first join, or when absent): a
   * server of another build refuses it with `build` before it joins, so no life is started.
   */
  build: string;
};

export type InputMessage = {
  t: typeof INPUT;
  seq: number;
  mx: number;
  my: number;
  aim: number;
  fire: boolean;
  dash: boolean;
};

export type ClientMessage = Hello | InputMessage;

export type RosterEntry = { id: number; name: string; team: string };

export type Welcome = {
  t: typeof WELCOME;
  v: number;
  /** Your entity id. */
  you: number;
  arena: number;
  build: string;
  world: { w: number; h: number };
  tickMs: number;
  tick: number;
  /** Everyone in the arena, you included. Later joins and leaves come as events. */
  roster: RosterEntry[];
};

/**
 * One player in a snapshot: id, x, y, vx, vy, aim, alive (0/1), untouchable after a hit or a
 * revive (0/1), dashing (0/1, v3), spawn-protected (0/1, v5, #58), effects (v7, #73: bit i set
 * while the pickup PICKUP_IDS[i] is active on a player in a life, so everyone sees a shield bubble
 * or a laser). Positions and velocities to 0.01, aim to 0.001. Fields are only ever appended, never
 * reordered.
 */
export type SnapshotPlayer = [
  id: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  aim: number,
  alive: 0 | 1,
  invulnerable: 0 | 1,
  dashing: 0 | 1,
  spawnProtected: 0 | 1,
  effects: number,
];
/**
 * One bug: id, its kind's index in BUG_KINDS, x, y (to 0.1). v6: a bug whose phase is not 0 (its
 * kind's first) adds a tail: phase (an index into its kind's phases), angle (its locked
 * direction, radians to 0.01) and ticksIn (ticks spent in that phase). A bug in phase 0, every
 * crawler for one, costs no more bytes than before.
 */
export type SnapshotBug = [id: number, kind: number, x: number, y: number] | [id: number, kind: number, x: number, y: number, phase: number, angle: number, ticksIn: number];
/**
 * A shot fired this tick: id, owner, where it left the barrel, its angle (to 0.001), and a review
 * laser shot (1) or not (0, v7). It flies per shotTravelAt.
 */
export type SnapshotShot = [id: number, owner: number, x: number, y: number, angle: number, laser: 0 | 1];
/**
 * A shot ended this tick: id, ended on a bug (1), on a bug's shell, doing no damage (2, v8, #80), or
 * at its range or a wall (0; a review laser shot may have hit bugs on the way, v7), units flown
 * from the barrel (to 0.1).
 */
export type SnapshotShotEnd = [id: number, hit: 0 | 1 | 2, travelled: number];
/** A bug killed this tick: bug id, by (0: nobody scores), x, y, points, its kind's index in BUG_KINDS (v6). */
export type SnapshotKill = [bug: number, by: number, x: number, y: number, points: number, kind: number];
/**
 * A downed player (v4): id, seconds left before bleeding out (to 0.01), the player holding revive
 * progress (0: none), and that progress, 0 to 1 (to 0.01). Only downed players have a row.
 */
export type SnapshotDown = [id: number, secondsLeft: number, reviver: number, progress: number];
/** A pickup on the floor (v7, #73): id, its index in PICKUP_IDS, x, y (to 0.1), ticks before it goes. */
export type SnapshotPickup = [id: number, pickup: number, x: number, y: number, ticksLeft: number];

/** Your own numbers, in your snapshots only. */
export type SnapshotMe = {
  /** Score, kills, hits in a row and its multiplier, this life. */
  sc: number;
  ki: number;
  st: number;
  mu: number;
  /** Gun heat, 0 to 1 (to 0.01), and whether the gun is locked (0/1). */
  he: number;
  lk: 0 | 1;
  /** Hits left this life. */
  hl: number;
  /** In a life (1) or out (0). Still 1 while down. */
  al: 0 | 1;
  /** Dash ticks left (above 0: dashing) and ticks until a dash press is accepted (v3). */
  dk: number;
  dc: number;
  /** Down (1): waiting for a revive (v4). */
  dn: 0 | 1;
  /** Ticks left of each pickup's effect, by its index in PICKUP_IDS (0: not active; v7). */
  fx: number[];
};

export type Snapshot = {
  t: typeof SNAPSHOT;
  tick: number;
  /** The last input sequence number the server applied for you (0 before any). */
  ack: number;
  /** Every player in the arena (at most 20), so the minimap shows everyone. */
  p: SnapshotPlayer[];
  /** Every bug in the arena (at most MAX_BUGS_PER_ARENA). */
  b: SnapshotBug[];
  /** Shots fired, shots ended and bugs killed in this tick. */
  s: SnapshotShot[];
  e: SnapshotShotEnd[];
  k: SnapshotKill[];
  /** Every downed player now. */
  d: SnapshotDown[];
  /** Every pickup on the floor now (at most MAX_PICKUPS_PER_ARENA; v7). */
  f: SnapshotPickup[];
  /** The arena's wave. */
  w: number;
  me: SnapshotMe;
};

export type ArenaEvent = {
  t: typeof EVENT;
  kind: EventKind;
  id: number;
  name?: string;
  team?: string;
  /** With "revive": the reviver. */
  by?: number;
  /** With "revive": the points it scored. */
  points?: number;
  /** With "pickup": the pickup's index in PICKUP_IDS (v7). */
  pickup?: number;
  /** With "over": the life's score, kills and length. */
  score?: number;
  kills?: number;
  seconds?: number;
};

/** With code `build`: the server's build id. */
export type ErrorMessage = { t: typeof ERROR; code: ErrorCode; build?: string };

export type ServerMessage = Welcome | Snapshot | ArenaEvent | ErrorMessage;

/** UTF-8 length of a string, without allocating. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Reads one client message, or null when it must be dropped: binary, over
 * MAX_CLIENT_MESSAGE_BYTES UTF-8 bytes, not JSON, not an object, an unknown `t`, or a field
 * missing, of the wrong type or not finite. Extra fields are ignored.
 */
export function parseClientMessage(raw: string | ArrayBuffer | Uint8Array): ClientMessage | null {
  if (typeof raw !== "string") return null;
  // UTF-8 is never shorter than UTF-16 code units, so this skips counting a huge message.
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES || utf8Bytes(raw) > MAX_CLIENT_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  if (m.t === INPUT) {
    const { seq, mx, my, aim, fire, dash } = m;
    if (!Number.isInteger(seq) || (seq as number) < 0 || (seq as number) > MAX_SEQ) return null;
    if (!finite(mx) || !finite(my) || !finite(aim)) return null;
    if (typeof fire !== "boolean" || typeof dash !== "boolean") return null;
    return { t: INPUT, seq: seq as number, mx, my, aim, fire, dash };
  }
  if (m.t === HELLO) {
    const { v, name, team, player, touch, build = "" } = m;
    if (!Number.isInteger(v)) return null;
    if (typeof name !== "string" || name.length > HELLO_NAME_MAX) return null;
    if (typeof team !== "string" || team.length > HELLO_NAME_MAX) return null;
    if (typeof player !== "string" || !PLAYER_ID.test(player)) return null;
    if (typeof touch !== "boolean") return null;
    if (typeof build !== "string" || build.length > HELLO_NAME_MAX) return null;
    return { t: HELLO, v: v as number, name, team, player, touch, build };
  }
  return null;
}

/**
 * Reads one server message in the browser, or null if it is not one. The server is trusted, so
 * this checks only that it is an object with a known `t`.
 */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m: unknown = JSON.parse(raw);
    return isRecord(m) && (SERVER_TYPES as readonly unknown[]).includes(m.t) ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}

const q1 = (v: number) => Math.round(v * 10) / 10;
const q2 = (v: number) => Math.round(v * 100) / 100;
const q3 = (v: number) => Math.round(v * 1000) / 1000;

type PlayerRow = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  aim: number;
  alive: boolean;
  invulnTicks: number;
  dashTicks: number;
  protectTicks: number;
  down: boolean;
  downTick: number;
  reviver: number;
  reviveTicks: number;
  /** Ticks left of each pickup's effect, by its index in PICKUP_IDS. */
  effect: readonly number[];
};

/** A player's effects as a bitmask: bit i while effect i is active in a life (v7). */
function effectBits(p: PlayerRow): number {
  if (!p.alive) return 0;
  let bits = 0;
  for (let i = 0; i < p.effect.length; i++) if (p.effect[i]! > 0) bits |= 1 << i;
  return bits;
}

/** The players part of a snapshot, as JSON: `[[id,x,y,vx,vy,aim,alive,inv,dash,prot,effects],...]`, quantized. */
export function encodeSnapshotPlayers(players: readonly PlayerRow[]): string {
  let s = "[";
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (i > 0) s += ",";
    s += `[${p.id},${q2(p.x)},${q2(p.y)},${q2(p.vx)},${q2(p.vy)},${q3(p.aim)},${p.alive ? 1 : 0},${p.alive && p.invulnTicks > 0 ? 1 : 0},${p.alive && p.dashTicks > 0 ? 1 : 0},${p.alive && p.protectTicks > 0 ? 1 : 0},${effectBits(p)}]`;
  }
  return s + "]";
}

/** What the shared part of a snapshot is built from: sim.ts ArenaState fits it. */
export type SharedSource = {
  tick: number;
  players: readonly PlayerRow[];
  bugs: readonly { id: number; kind: string; x: number; y: number; phase: number; phaseTicks: number; dx: number; dy: number }[];
  floor: readonly { id: number; kind: string; x: number; y: number; ticksLeft: number }[];
  events: {
    shotsFired: readonly { id: number; owner: number; x: number; y: number; angle: number; laser: boolean }[];
    shotsEnded: readonly { id: number; hit: boolean; blocked: boolean; travelled: number }[];
    kills: readonly { bug: number; by: number; x: number; y: number; points: number; kind: string }[];
  };
};

/**
 * The part of a snapshot every socket in an arena shares, built once per tick: `"p":...,"b":...,
 * "s":...,"e":...,"k":...,"d":...,"f":...,"w":...` (no braces). `kinds` is BUG_KINDS and `pickups`
 * PICKUP_IDS, passed in so this file imports no simulation; `wave` is the arena's wave. `src.tick` is the tick after the step
 * (the snapshot's tick), so a player who went down in the step just run shows DOWN_S less one
 * tick left.
 */
export function encodeSnapshotShared(src: SharedSource, kinds: readonly string[], wave: number, pickups: readonly string[]): string {
  let b = "[";
  for (let i = 0; i < src.bugs.length; i++) {
    const g = src.bugs[i]!;
    if (i > 0) b += ",";
    b += `[${g.id},${kinds.indexOf(g.kind)},${q1(g.x)},${q1(g.y)}`;
    b += g.phase === 0 ? "]" : `,${g.phase},${q2(Math.atan2(g.dy, g.dx))},${g.phaseTicks}]`;
  }
  b += "]";
  const ev = src.events;
  let s = "[";
  for (let i = 0; i < ev.shotsFired.length; i++) {
    const f = ev.shotsFired[i]!;
    if (i > 0) s += ",";
    s += `[${f.id},${f.owner},${q2(f.x)},${q2(f.y)},${q3(f.angle)},${f.laser ? 1 : 0}]`;
  }
  s += "]";
  let e = "[";
  for (let i = 0; i < ev.shotsEnded.length; i++) {
    const x = ev.shotsEnded[i]!;
    if (i > 0) e += ",";
    e += `[${x.id},${x.blocked ? 2 : x.hit ? 1 : 0},${q1(x.travelled)}]`;
  }
  e += "]";
  let k = "[";
  for (let i = 0; i < ev.kills.length; i++) {
    const x = ev.kills[i]!;
    if (i > 0) k += ",";
    k += `[${x.bug},${x.by},${q1(x.x)},${q1(x.y)},${x.points},${kinds.indexOf(x.kind)}]`;
  }
  k += "]";
  let d = "[";
  for (let i = 0; i < src.players.length; i++) {
    const p = src.players[i]!;
    if (!p.down) continue;
    if (d.length > 1) d += ",";
    const left = (Math.max(0, DOWN_TICKS - (src.tick - p.downTick)) * TICK_MS) / 1000;
    d += `[${p.id},${q2(left)},${p.reviver},${q2(p.reviveTicks / REVIVE_TICKS)}]`;
  }
  d += "]";
  let f = "[";
  for (let i = 0; i < src.floor.length; i++) {
    const x = src.floor[i]!;
    if (i > 0) f += ",";
    f += `[${x.id},${pickups.indexOf(x.kind)},${q1(x.x)},${q1(x.y)},${x.ticksLeft}]`;
  }
  f += "]";
  return `"p":${encodeSnapshotPlayers(src.players)},"b":${b},"s":${s},"e":${e},"k":${k},"d":${d},"f":${f},"w":${wave}`;
}

/** One socket's snapshot: its own ack and numbers around the shared part. */
export function encodeSnapshot(tick: number, ack: number, me: SnapshotMe, shared: string): string {
  return `{"t":"${SNAPSHOT}","tick":${tick},"ack":${ack},"me":{"sc":${me.sc},"ki":${me.ki},"st":${me.st},"mu":${me.mu},"he":${q2(me.he)},"lk":${me.lk},"hl":${me.hl},"al":${me.al},"dk":${me.dk},"dc":${me.dc},"dn":${me.dn},"fx":[${me.fx.join(",")}]},${shared}}`;
}

export function encodeHello(v: number, name: string, team: string, player: string, touch: boolean, build = ""): string {
  const m: Hello = { t: HELLO, v, name, team, player, touch, build };
  return JSON.stringify(m);
}

/** An input, unrounded: the browser predicts with exactly the numbers the server will step. */
export function encodeInput(i: Omit<InputMessage, "t">): string {
  const m: InputMessage = { t: INPUT, seq: i.seq, mx: i.mx, my: i.my, aim: i.aim, fire: i.fire, dash: i.dash };
  return JSON.stringify(m);
}
