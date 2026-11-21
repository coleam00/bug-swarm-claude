// The /ws endpoint's WebSocket handlers (Bun's built-in WebSocket). A socket must say hello
// within HELLO_TIMEOUT_MS: its name passes rules.ts and is not a bot name, its team is a team and
// its protocol version matches, else it gets an `error` and is closed. After the welcome it sends
// inputs, at most INPUTS_PER_SECOND; the rest are dropped. Anything the validator refuses is
// dropped without closing the socket. The server pings every socket every PING_MS; one it has not
// heard from (a message or a pong) for SILENT_MS is dropped, so a peer that vanished without
// closing (a phone losing its network) does not keep a frozen robot in the arena. Bun's own
// idle timeout can't do this: the tick's snapshots keep it alive.
// A hidden name (`bun run hide`, or a stored name the word lists now refuse) is refused at hello,
// and every HIDE_SWEEP_MS the joined sockets are checked against it, off the tick: a name hidden
// mid-life gets the same `error name` and close, and leaving saves its life as a disconnect does.
// When the server stops (a redeploy), `restart` sends every socket `error restarting` and closes it
// (the lives were already ended and saved, Rooms.endAll); from then on any socket is refused the same
// way, so a quick reconnect can't join an arena on a server that is going away.
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_HELLO,
  ERROR_NAME,
  ERROR_RESTARTING,
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
/** The WebSocket close code for a server restarting (a redeploy): come back later. */
export const CLOSE_RESTARTING = 1012;
/** How often joined sockets are checked for a name hidden since they joined, ms. */
export const HIDE_SWEEP_MS = 2000;

export type SocketData = {
  limiter: InputLimiter;
  room: number | null;
  entity: number | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
  /** When the socket last sent a message or a pong, ms. */
  lastHeard: number;
  liveTimer: ReturnType<typeof setInterval> | null;
  /** The name the socket joined with, once welcomed. */
  name: string | null;
};

/** The data a new socket starts with, passed to server.upgrade. */
export function newSocketData(): SocketData {
  return { limiter: createInputLimiter(), room: null, entity: null, helloTimer: null, lastHeard: 0, liveTimer: null, name: null };
}

/** How often to ping and when to give up; the defaults are the real ones, tests shorten them. */
export type Liveness = { pingMs: number; silentMs: number };

export type ArenaSocketOptions = {
  now?: () => number;
  liveness?: Liveness;
  /** True for a name that may not play (hidden from the boards). Defaults to none. */
  isHidden?: (name: string) => boolean;
  /** How often joined sockets are checked with `isHidden`, ms; tests shorten it. */
  sweepMs?: number;
};

export type ArenaSockets = WebSocketHandler<SocketData> & {
  /**
   * The server is stopping: sends every open socket `error restarting` and closes it, and refuses
   * every later one the same way. Call it after Rooms.endAll: it does not leave the arenas.
   */
  restart(): void;
  /** Sockets open now, welcomed or not. */
  readonly openCount: number;
};

export function createArenaSockets(rooms: Rooms, opts: ArenaSocketOptions = {}): ArenaSockets {
  const now = opts.now ?? Date.now;
  const { pingMs, silentMs } = opts.liveness ?? { pingMs: PING_MS, silentMs: SILENT_MS };
  const isHidden = opts.isHidden ?? (() => false);
  const sweepMs = opts.sweepMs ?? HIDE_SWEEP_MS;
  /** The welcomed sockets, which the sweep checks. */
  const joined = new Set<ServerWebSocket<SocketData>>();
  /** Every open socket, for restart. */
  const all = new Set<ServerWebSocket<SocketData>>();
  let restarting = false;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  const refuse = (ws: ServerWebSocket<SocketData>, code: ErrorCode) => {
    ws.send(JSON.stringify({ t: ERROR, code }));
    ws.close(CLOSE_REFUSED, code);
  };

  const sendRestarting = (ws: ServerWebSocket<SocketData>) => {
    ws.send(JSON.stringify({ t: ERROR, code: ERROR_RESTARTING }));
    ws.close(CLOSE_RESTARTING, ERROR_RESTARTING);
  };

  const stopSweep = () => {
    if (sweepTimer) clearInterval(sweepTimer);
    sweepTimer = null;
  };
  // Runs only while someone is joined, so an idle server (and a test that never joins) has no timer.
  const sweep = () => {
    for (const ws of joined) {
      if (ws.data.name !== null && isHidden(ws.data.name)) {
        joined.delete(ws);
        refuse(ws, ERROR_NAME);
      }
    }
    if (joined.size === 0) stopSweep();
  };

  const hello = (ws: ServerWebSocket<SocketData>, m: Hello) => {
    if (m.v !== PROTOCOL_VERSION) return refuse(ws, ERROR_VERSION);
    const name = checkName(m.name);
    if (!name.ok || isBotName(name.name) || isHidden(name.name)) return refuse(ws, ERROR_NAME);
    if (!isTeam(m.team)) return refuse(ws, ERROR_TEAM);
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    const entered = rooms.join(name.name, m.team, { playerKey: m.player, touch: m.touch }, (msg) => void ws.send(msg));
    ws.data.room = entered.room;
    ws.data.entity = entered.entity;
    ws.data.name = name.name;
    ws.send(JSON.stringify(entered.welcome));
    joined.add(ws);
    if (!sweepTimer) sweepTimer = setInterval(sweep, sweepMs);
  };

  return {
    restart() {
      restarting = true;
      stopSweep();
      joined.clear();
      for (const ws of all) {
        // The arenas are gone (Rooms.endAll): the close must not leave one again.
        ws.data.room = null;
        ws.data.entity = null;
        sendRestarting(ws);
      }
    },
    get openCount() {
      return all.size;
    },
    maxPayloadLength: MAX_FRAME_BYTES,
    open(ws) {
      all.add(ws);
      if (restarting) return sendRestarting(ws);
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
        if (restarting) sendRestarting(ws);
        else if (room === null) hello(ws, m);
        return;
      }
      if (room === null || entity === null) return;
      if (!ws.data.limiter.allow(now())) return;
      rooms.input(room, entity, { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash });
    },
    close(ws) {
      all.delete(ws);
      joined.delete(ws);
      if (joined.size === 0) stopSweep();
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
