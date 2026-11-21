// The /ws endpoint's WebSocket handlers (Bun's built-in WebSocket). A socket must say hello
// within HELLO_TIMEOUT_MS: its name passes rules.ts and is not a bot name, its team is a team and
// its protocol version matches, else it gets an `error` and is closed. After the welcome it sends
// inputs, at most INPUTS_PER_SECOND; the rest are dropped. Anything the validator refuses is
// dropped without closing the socket. The server pings every socket every PING_MS; one it has not
// heard from (a message or a pong) for SILENT_MS is dropped, so a peer that vanished without
// closing (a phone losing its network) does not keep a frozen robot in the arena. Bun's own
// idle timeout can't do this: the tick's snapshots keep it alive.
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_HELLO,
  ERROR_NAME,
  ERROR_TEAM,
  ERROR_VERSION,
  HELLO,
  parseClientMessage,
  type ErrorCode,
  type Hello,
} from "../../shared/arena/protocol";
import { checkName, isBotName, isTeam } from "../rules";
import { createInputLimiter, type InputLimiter } from "./limiter";
import type { Rooms } from "./rooms";

/** A socket that has not said hello by then is closed. */
export const HELLO_TIMEOUT_MS = 5000;
/** Frames over this are closed by Bun itself; 1 KiB to 4 KiB is dropped by the validator. */
export const MAX_FRAME_BYTES = 4096;
/** How often the server pings each socket, ms. Browsers answer pings even in hidden tabs. */
export const PING_MS = 5000;
/** A socket silent (no message, no pong) for longer than this is dropped, ms. */
export const SILENT_MS = 15_000;
/** The WebSocket close code for a refused hello (policy violation). */
export const CLOSE_REFUSED = 1008;

export type SocketData = {
  limiter: InputLimiter;
  room: number | null;
  entity: number | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /** When the socket last sent a message or a pong, ms. */
  lastHeard: number;
  liveTimer: ReturnType<typeof setInterval> | null;
};

/** The data a new socket starts with, passed to server.upgrade. */
export function newSocketData(): SocketData {
  return { limiter: createInputLimiter(), room: null, entity: null, helloTimer: null, lastHeard: 0, liveTimer: null };
}

/** How often to ping and when to give up; the defaults are the real ones, tests shorten them. */
export type Liveness = { pingMs: number; silentMs: number };

export function createArenaSockets(rooms: Rooms, opts: { now?: () => number; liveness?: Liveness } = {}): WebSocketHandler<SocketData> {
  const now = opts.now ?? Date.now;
  const { pingMs, silentMs } = opts.liveness ?? { pingMs: PING_MS, silentMs: SILENT_MS };

  const refuse = (ws: ServerWebSocket<SocketData>, code: ErrorCode) => {
    ws.send(JSON.stringify({ t: ERROR, code }));
    ws.close(CLOSE_REFUSED, code);
  };

  const hello = (ws: ServerWebSocket<SocketData>, m: Hello) => {
    if (m.v !== PROTOCOL_VERSION) return refuse(ws, ERROR_VERSION);
    const name = checkName(m.name);
    if (!name.ok || isBotName(name.name)) return refuse(ws, ERROR_NAME);
    if (!isTeam(m.team)) return refuse(ws, ERROR_TEAM);
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    const joined = rooms.join(name.name, m.team, (msg) => void ws.send(msg));
    ws.data.room = joined.room;
    ws.data.entity = joined.entity;
    ws.send(JSON.stringify(joined.welcome));
  };

  return {
    maxPayloadLength: MAX_FRAME_BYTES,
    open(ws) {
      ws.data.helloTimer = setTimeout(() => refuse(ws, ERROR_HELLO), HELLO_TIMEOUT_MS);
      ws.data.lastHeard = now();
      ws.data.liveTimer = setInterval(() => {
        // terminate, not close: a vanished peer never answers the close handshake.
        if (now() - ws.data.lastHeard > silentMs) ws.terminate();
        else ws.ping();
      }, pingMs);
    },
    pong(ws) {
      ws.data.lastHeard = now();
    },
    message(ws, raw) {
      ws.data.lastHeard = now();
      const m = parseClientMessage(raw as string | Uint8Array);
      if (!m) return;
      const { room, entity } = ws.data;
      if (m.t === HELLO) {
        if (room === null) hello(ws, m);
        return;
      }
      if (room === null || entity === null) return;
      if (!ws.data.limiter.allow(now())) return;
      rooms.input(room, entity, { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash });
    },
    close(ws) {
      if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
      ws.data.helloTimer = null;
      if (ws.data.liveTimer) clearInterval(ws.data.liveTimer);
      ws.data.liveTimer = null;
      if (ws.data.room !== null && ws.data.entity !== null) rooms.leave(ws.data.room, ws.data.entity);
      ws.data.room = null;
      ws.data.entity = null;
    },
  };
}
