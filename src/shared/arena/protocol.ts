// The arena's WebSocket protocol (release 2): JSON text frames, each an object whose `t` names
// its type. One validator, `parseClientMessage`, is the only way the server reads a client
// message: anything malformed, unknown or over MAX_CLIENT_MESSAGE_BYTES is dropped (null). The
// validator rejects junk only; the simulation still clamps what it accepts (sim.ts clampInput).
import { MAX_CLIENT_MESSAGE_BYTES } from "./constants";

/** Client to server. */
export const CLIENT_TYPES = ["hello", "input"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const [HELLO, INPUT] = CLIENT_TYPES;

/** Server to client. */
export const SERVER_TYPES = ["welcome", "snapshot", "event", "error"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];
export const [WELCOME, SNAPSHOT, EVENT, ERROR] = SERVER_TYPES;

/**
 * What an `event` reports: a join, a leave, or your life being over (sent to you only). Hits,
 * kills and shots travel in snapshots. Later items append down, revive and pickup.
 */
export const EVENT_KINDS = ["join", "leave", "over"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const [JOIN, LEAVE, OVER] = EVENT_KINDS;

/** Why the server refused a hello. The socket closes after each. */
export const ERROR_CODES = ["version", "name", "team", "hello"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const [ERROR_VERSION, ERROR_NAME, ERROR_TEAM, ERROR_HELLO] = ERROR_CODES;

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
 * One player in a snapshot: id, x, y, vx, vy, aim, alive (0/1), untouchable after a hit (0/1),
 * spawn-protected (0/1, #58). Positions and velocities to 0.01, aim to 0.001. Fields are only ever
 * appended, never reordered.
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
  spawnProtected: 0 | 1,
];
/** One bug: id, its kind's index in BUG_KINDS, x, y (to 0.1). */
export type SnapshotBug = [id: number, kind: number, x: number, y: number];
/** A shot fired this tick: id, owner, where it left the barrel, its angle (to 0.001). It flies per shotTravelAt. */
export type SnapshotShot = [id: number, owner: number, x: number, y: number, angle: number];
/** A shot ended this tick: id, hit (1) or miss (0), units flown from the barrel (to 0.1). */
export type SnapshotShotEnd = [id: number, hit: 0 | 1, travelled: number];
/** A bug killed this tick: bug id, by (0: nobody scores), x, y, points. */
export type SnapshotKill = [bug: number, by: number, x: number, y: number, points: number];

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
  /** In a life (1) or out (0). */
  al: 0 | 1;
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
  /** With "over": the life's score, kills and length. */
  score?: number;
  kills?: number;
  seconds?: number;
};

export type ErrorMessage = { t: typeof ERROR; code: ErrorCode };

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
    const { v, name, team, player, touch } = m;
    if (!Number.isInteger(v)) return null;
    if (typeof name !== "string" || name.length > HELLO_NAME_MAX) return null;
    if (typeof team !== "string" || team.length > HELLO_NAME_MAX) return null;
    if (typeof player !== "string" || !PLAYER_ID.test(player)) return null;
    if (typeof touch !== "boolean") return null;
    return { t: HELLO, v: v as number, name, team, player, touch };
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

type PlayerRow = { id: number; x: number; y: number; vx: number; vy: number; aim: number; alive: boolean; invulnTicks: number; protectTicks: number };

/** The players part of a snapshot, as JSON: `[[id,x,y,vx,vy,aim,alive,inv,prot],...]`, quantized. */
export function encodeSnapshotPlayers(players: readonly PlayerRow[]): string {
  let s = "[";
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (i > 0) s += ",";
    s += `[${p.id},${q2(p.x)},${q2(p.y)},${q2(p.vx)},${q2(p.vy)},${q3(p.aim)},${p.alive ? 1 : 0},${p.alive && p.invulnTicks > 0 ? 1 : 0},${p.alive && p.protectTicks > 0 ? 1 : 0}]`;
  }
  return s + "]";
}

/** What the shared part of a snapshot is built from: sim.ts ArenaState fits it. */
export type SharedSource = {
  tick: number;
  players: readonly PlayerRow[];
  bugs: readonly { id: number; kind: string; x: number; y: number }[];
  events: {
    shotsFired: readonly { id: number; owner: number; x: number; y: number; angle: number }[];
    shotsEnded: readonly { id: number; hit: boolean; travelled: number }[];
    kills: readonly { bug: number; by: number; x: number; y: number; points: number }[];
  };
};

/**
 * The part of a snapshot every socket in an arena shares, built once per tick: `"p":...,"b":...,
 * "s":...,"e":...,"k":...,"w":...` (no braces). `kinds` is BUG_KINDS, passed in so this file
 * imports no simulation; `wave` is the arena's wave.
 */
export function encodeSnapshotShared(src: SharedSource, kinds: readonly string[], wave: number): string {
  let b = "[";
  for (let i = 0; i < src.bugs.length; i++) {
    const g = src.bugs[i]!;
    if (i > 0) b += ",";
    b += `[${g.id},${kinds.indexOf(g.kind)},${q1(g.x)},${q1(g.y)}]`;
  }
  b += "]";
  const ev = src.events;
  let s = "[";
  for (let i = 0; i < ev.shotsFired.length; i++) {
    const f = ev.shotsFired[i]!;
    if (i > 0) s += ",";
    s += `[${f.id},${f.owner},${q2(f.x)},${q2(f.y)},${q3(f.angle)}]`;
  }
  s += "]";
  let e = "[";
  for (let i = 0; i < ev.shotsEnded.length; i++) {
    const x = ev.shotsEnded[i]!;
    if (i > 0) e += ",";
    e += `[${x.id},${x.hit ? 1 : 0},${q1(x.travelled)}]`;
  }
  e += "]";
  let k = "[";
  for (let i = 0; i < ev.kills.length; i++) {
    const x = ev.kills[i]!;
    if (i > 0) k += ",";
    k += `[${x.bug},${x.by},${q1(x.x)},${q1(x.y)},${x.points}]`;
  }
  k += "]";
  return `"p":${encodeSnapshotPlayers(src.players)},"b":${b},"s":${s},"e":${e},"k":${k},"w":${wave}`;
}

/** One socket's snapshot: its own ack and numbers around the shared part. */
export function encodeSnapshot(tick: number, ack: number, me: SnapshotMe, shared: string): string {
  return `{"t":"${SNAPSHOT}","tick":${tick},"ack":${ack},"me":{"sc":${me.sc},"ki":${me.ki},"st":${me.st},"mu":${me.mu},"he":${q2(me.he)},"lk":${me.lk},"hl":${me.hl},"al":${me.al}},${shared}}`;
}

export function encodeHello(v: number, name: string, team: string, player: string, touch: boolean): string {
  const m: Hello = { t: HELLO, v, name, team, player, touch };
  return JSON.stringify(m);
}

/** An input, unrounded: the browser predicts with exactly the numbers the server will step. */
export function encodeInput(i: Omit<InputMessage, "t">): string {
  const m: InputMessage = { t: INPUT, seq: i.seq, mx: i.mx, my: i.my, aim: i.aim, fire: i.fire, dash: i.dash };
  return JSON.stringify(m);
}
