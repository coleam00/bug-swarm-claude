// The arena's connection: one WebSocket to /ws on this page's host, a hello on open, the
// server's messages handed to game.ts, and a rejoin with backoff (0.5 s doubling to 5 s) when the
// connection drops, or goes silent: the server sends 20 snapshots a second, so SERVER_SILENT_MS
// with nothing means it is gone even if no close arrived (a half-open connection). A refused name
// or team, or another protocol version, does not retry. A redeploy (the server's `error
// restarting`, then a close) shows "Reconnecting..." and rejoins the same way; when a rejoin's
// welcome carries a build id other than the first welcome's, or the new server refuses this page's
// protocol version, the page is out of date: `newBuild` is called (game.ts reloads) instead of
// playing on. `close()` ends it for good: the socket, the silence check and any pending rejoin
// (the page left the arena).
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_NAME,
  ERROR_RESTARTING,
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
    /** "Connecting...", "Reconnecting...", "Updating...", "Reload to update", or null when playing. */
    status: (text: string | null) => void;
    /** A name or team the server refused. */
    refused: (code: ErrorCode) => void;
    /**
     * The server was redeployed with a new build (its build id, or "" when only its protocol
     * version told): this page is out of date. Called once; nothing reconnects after it.
     */
    newBuild: (build: string) => void;
  },
  /** The /ws URL; defaults to this page's (tests pass a server's). */
  url?: string,
): Connection {
  const target = url ?? socketUrl(location);
  let ws: WebSocket | null = null;
  let attempt = 0;
  let final = false;
  /** The build id of the first welcome: the build this page was loaded against. */
  let firstBuild: string | null = null;

  /** The server runs another build: stop here and hand over to `newBuild`. */
  const outdated = (socket: WebSocket, build: string) => {
    final = true;
    on.status("Updating...");
    on.newBuild(build);
    socket.close();
  };
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
    const socket = new WebSocket(target);
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
        if (firstBuild === null) firstBuild = m.build;
        else if (m.build !== firstBuild) return outdated(socket, m.build);
        attempt = 0;
        on.status(null);
      } else if (m.t === ERROR && m.code === ERROR_RESTARTING) {
        // The close that follows schedules the rejoin.
        on.status("Reconnecting...");
      } else if (m.t === ERROR && m.code === ERROR_VERSION && firstBuild !== null) {
        // A rejoin to a server that no longer speaks this page's protocol: a redeploy. (On the very
        // first connect it stays final below, so a stale cache can't loop on reloads.)
        return outdated(socket, "");
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
