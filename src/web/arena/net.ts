// The arena's connection: one WebSocket to /ws on this page's host, a hello on open, the
// server's messages handed to game.ts, and a rejoin with backoff (0.5 s doubling to 5 s) when the
// connection drops, or goes silent: the server sends 20 snapshots a second, so SERVER_SILENT_MS
// with nothing means it is gone even if no close arrived (a half-open connection). A refused name
// or team, or another protocol version, does not retry. `close()` ends it for good: the socket,
// the silence check and any pending rejoin (the page left the arena).
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_NAME,
  ERROR_TEAM,
  ERROR_VERSION,
  WELCOME,
  encodeHello,
  parseServerMessage,
  type ErrorCode,
  type ServerMessage,
} from "../../shared/arena/protocol";

export const RECONNECT_FIRST_MS = 500;
export const RECONNECT_MAX_MS = 5000;
/** A connection that has received nothing for this long is dropped and rejoined, ms. */
export const SERVER_SILENT_MS = 5000;

/** True when a socket last heard from at `lastHeardMs` has been silent too long at `nowMs`. */
export function serverSilent(lastHeardMs: number, nowMs: number): boolean {
  return nowMs - lastHeardMs > SERVER_SILENT_MS;
}

/** The wait before rejoin attempt `attempt` (0 first): 0.5 s doubling to 5 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_FIRST_MS * 2 ** Math.min(attempt, 10));
}

/** Errors after which rejoining can't help: the player has to change something first. */
export function isFinalError(code: ErrorCode): boolean {
  return code === ERROR_NAME || code === ERROR_TEAM || code === ERROR_VERSION;
}

/** The /ws URL for a page at `location`: wss on https. */
export function socketUrl(loc: { protocol: string; host: string }): string {
  return `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`;
}

export type Hello = { name: string; team: string; player: string; touch: () => boolean };

export type Connection = {
  /** Sends if the socket is open; otherwise drops it (inputs are worthless late). */
  send(message: string): void;
  readonly open: boolean;
  /** Closes the socket and stops every timer; nothing reconnects after it. */
  close(): void;
};

export function connectArena(
  hello: Hello,
  on: {
    message: (m: ServerMessage) => void;
    /** "Connecting...", "Reconnecting...", "Reload to update", or null when playing. */
    status: (text: string | null) => void;
    /** A name or team the server refused. */
    refused: (code: ErrorCode) => void;
  },
): Connection {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let final = false;
  let lastHeard = 0;
  let rejoin: ReturnType<typeof setTimeout> | null = null;

  /** Gives up on `socket` (closed, or silent) and schedules a rejoin. */
  const drop = (socket: WebSocket) => {
    if (ws !== socket) return;
    ws = null;
    if (final) return;
    on.status("Reconnecting...");
    rejoin = setTimeout(open, reconnectDelay(attempt++));
  };

  const open = () => {
    rejoin = null;
    if (final) return;
    const socket = new WebSocket(socketUrl(location));
    ws = socket;
    lastHeard = performance.now();
    socket.addEventListener("open", () => {
      // Closed before it opened: never say hello (a hello joins, and leaving saves a life).
      if (ws !== socket) return;
      socket.send(encodeHello(PROTOCOL_VERSION, hello.name, hello.team, hello.player, hello.touch()));
    });
    socket.addEventListener("message", (e) => {
      if (ws !== socket) return;
      lastHeard = performance.now();
      const m = parseServerMessage(e.data);
      if (!m) return;
      if (m.t === WELCOME) {
        attempt = 0;
        on.status(null);
      } else if (m.t === ERROR && isFinalError(m.code)) {
        final = true;
        if (m.code === ERROR_VERSION) on.status("Reload to update");
        else on.refused(m.code);
      }
      on.message(m);
    });
    socket.addEventListener("close", () => drop(socket));
  };

  on.status("Connecting...");
  open();
  const silence = setInterval(() => {
    const socket = ws;
    if (!socket || !serverSilent(lastHeard, performance.now())) return;
    drop(socket);
    socket.close();
  }, 1000);
  return {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
    },
    get open() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
    close() {
      final = true;
      clearInterval(silence);
      if (rejoin) clearTimeout(rejoin);
      rejoin = null;
      const socket = ws;
      ws = null;
      socket?.close();
    },
  };
}
