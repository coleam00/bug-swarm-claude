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

/** What an `event` reports. Later items append hit, kill, down, revive, pickup and life-over. */
export const EVENT_KINDS = ["join", "leave"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const [JOIN, LEAVE] = EVENT_KINDS;

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

/** One player in a snapshot: id, x, y, vx, vy, aim. Positions and velocities to 0.01, aim to 0.001. */
export type SnapshotPlayer = [id: number, x: number, y: number, vx: number, vy: number, aim: number];

export type Snapshot = {
  t: typeof SNAPSHOT;
  tick: number;
  /** The last input sequence number the server applied for you (0 before any). */
  ack: number;
  /** Every player in the arena (at most 20), so the minimap shows everyone. */
  p: SnapshotPlayer[];
};

export type ArenaEvent = { t: typeof EVENT; kind: EventKind; id: number; name?: string; team?: string };

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

const q2 = (v: number) => Math.round(v * 100) / 100;
const q3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The players part of a snapshot, as JSON, built once per tick and shared by every socket in the
 * arena: `[[id,x,y,vx,vy,aim],...]`, quantized.
 */
export function encodeSnapshotPlayers(players: readonly { id: number; x: number; y: number; vx: number; vy: number; aim: number }[]): string {
  let s = "[";
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    if (i > 0) s += ",";
    s += `[${p.id},${q2(p.x)},${q2(p.y)},${q2(p.vx)},${q2(p.vy)},${q3(p.aim)}]`;
  }
  return s + "]";
}

/** One socket's snapshot: its own ack around the shared players JSON. */
export function encodeSnapshot(tick: number, ack: number, playersJson: string): string {
  return `{"t":"${SNAPSHOT}","tick":${tick},"ack":${ack},"p":${playersJson}}`;
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
