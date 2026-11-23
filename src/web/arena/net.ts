// The arena's connection: one WebSocket to /ws on this page's host, a hello on open, the
// server's messages handed to game.ts, and a rejoin with backoff (0.5 s doubling to 5 s) when the
// connection drops, or goes silent: the server sends 20 snapshots a second, so SERVER_SILENT_MS
// with nothing means it is gone even if no close arrived (a half-open connection). A refused name
// or team, or another protocol version, does not retry. A redeploy (the server's `error
// restarting`, then a close) shows "Reconnecting..." and rejoins the same way. A rejoin's hello
// carries the build id of the first welcome; when the new server refuses it for another build (or
// for this page's protocol version), the page is out of date: `newBuild` is called (game.ts
// reloads) instead of playing on. Either refusal comes before the server joins it to an arena,
// so the update saves no empty life. `close()` ends it for good: the socket, the silence check and any pending rejoin
// (the page left the arena).
// `watchArena` (#79) opens the same connection for the start screen: it sends `watch` instead of
// a hello, and never shows a status or reloads. A refused watch (the server's watcher cap, or
// another version) calls `unavailable` and stops; a drop or a restart rejoins quietly. `play()`
// turns it into the player's connection on the same socket: the hello goes on the next turn, so
// a `close()` in the same turn (React StrictMode unmounting at once) never joins, and it carries
// the build of the watch's first welcome, so a page made stale by a redeploy still reloads.
// Snapshots arrive culled and as deltas (v11, #89): each socket decodes them through its own
// reader (view.ts), reset by every welcome, and one that cannot be decoded yet (a lost delta,
// before the next keyframe) is skipped. `received` counts the characters that arrived (the F
// readout's KB/s; snapshots are ASCII, so characters are bytes).
// A server refusing a player for its limits (#104: `limit`, too many connections from the
// player's address; `busy`, MAX_PEOPLE playing) shows a short message (`refusalStatus`) that stays
// up through the close and the retries, until a welcome; the backoff is the "try again".
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_BUILD,
  ERROR_BUSY,
  ERROR_FULL,
  ERROR_LIMIT,
  ERROR_NAME,
  ERROR_RESTARTING,
  ERROR_TEAM,
  ERROR_VERSION,
  WELCOME,
  encodeHello,
  encodeWatch,
  parseServerMessage,
  type ErrorCode,
  type WireMessage,
  type ServerMessage,
} from "../../shared/arena/protocol";
import { createSnapshotReader } from "../../shared/arena/view";

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

/**
 * What a player sees while the server refuses them for its limits (#104), or null for any other
 * code. Neither is final: the connection keeps retrying with backoff.
 */
export function refusalStatus(code: ErrorCode): string | null {
  if (code === ERROR_LIMIT) return "Too many connections from your network. Trying again...";
  if (code === ERROR_BUSY) return "Arenas are full. Trying again in a moment...";
  return null;
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
  /** Characters received on every socket of this connection so far. */
  readonly received: number;
  /** Closes the socket and stops every timer; nothing reconnects after it. */
  close(): void;
};

/** What a player's connection tells the arena. */
export type PlayHandlers = {
  message: (m: ServerMessage) => void;
  /**
   * "Connecting...", "Reconnecting...", "Updating...", "Reload to update", a refusal for the
   * server's limits (refusalStatus), or null when playing.
   */
  status: (text: string | null) => void;
  /** A name or team the server refused. */
  refused: (code: ErrorCode) => void;
  /**
   * The server was redeployed with a new build (its build id, or "" when only its protocol
   * version told): this page is out of date. Called once; nothing reconnects after it.
   */
  newBuild: (build: string) => void;
};

/** What a watching connection tells the start screen. */
export type WatchHandlers = {
  message: (m: ServerMessage) => void;
  /** The connection dropped; it rejoins on its own. */
  dropped: () => void;
  /** The server refused the watch (full, or another version). Once; nothing reconnects after it. */
  unavailable: () => void;
};

/** A watching connection, which can become the player's. */
export type WatchConnection = Connection & {
  /**
   * Plays on this connection: the hello goes on the open socket on the next turn, or when a
   * connecting socket opens, or on a new socket between rejoins. From then on it is a player's
   * connection exactly like connectArena's.
   */
  play(hello: Hello, on: PlayHandlers): Connection;
};

export function connectArena(
  hello: Hello,
  on: PlayHandlers,
  /** The /ws URL; defaults to this page's (tests pass a server's). */
  url?: string,
): Connection {
  return connect({ hello, play: on, watch: null }, url);
}

/** Watches an arena (the start screen, #79). */
export function watchArena(on: WatchHandlers, url?: string): WatchConnection {
  return connect({ hello: null, play: null, watch: on }, url);
}

/** Watching (no hello) or playing; play() switches one to the other, once. */
type Mode = { hello: Hello | null; play: PlayHandlers | null; watch: WatchHandlers | null };

function connect(mode: Mode, url?: string): WatchConnection {
  const target = url ?? socketUrl(location);
  let ws: WebSocket | null = null;
  let attempt = 0;
  let final = false;
  /** The build id of the first welcome: the build this page was loaded against. */
  let firstBuild: string | null = null;
  /** The hello play() is about to send on the open socket. */
  let pending: ReturnType<typeof setTimeout> | null = null;
  /** The message for the server's last limit refusal (refusalStatus), shown until a welcome. */
  let refusal: string | null = null;

  const sayHello = (socket: WebSocket) => {
    const h = mode.hello;
    if (h) socket.send(encodeHello(PROTOCOL_VERSION, h.name, h.team, h.player, h.touch(), firstBuild ?? ""));
    else socket.send(encodeWatch(PROTOCOL_VERSION));
  };

  /** The server runs another build: stop here and hand over to `newBuild`. */
  const outdated = (on: PlayHandlers, socket: WebSocket, build: string) => {
    final = true;
    on.status("Updating...");
    on.newBuild(build);
    socket.close();
  };
  let lastHeard = 0;
  let received = 0;
  let rejoin: ReturnType<typeof setTimeout> | null = null;

  /** Gives up on `socket` (closed, or silent) and schedules a rejoin. */
  const drop = (socket: WebSocket) => {
    if (ws !== socket) return;
    ws = null;
    if (final) return;
    if (mode.play) mode.play.status(refusal ?? "Reconnecting...");
    else mode.watch?.dropped();
    rejoin = setTimeout(open, reconnectDelay(attempt++));
  };

  /** A message while watching: a refusal (anything but a restart) ends the watch for good. */
  const watching = (on: WatchHandlers, socket: WebSocket, m: ServerMessage) => {
    if (m.t === WELCOME) {
      firstBuild ??= m.build;
      attempt = 0;
    } else if (m.t === ERROR && m.code !== ERROR_RESTARTING) {
      final = true;
      on.unavailable();
      socket.close();
      return;
    }
    on.message(m);
  };

  const open = () => {
    rejoin = null;
    if (final) return;
    const socket = new WebSocket(target);
    ws = socket;
    // A new socket starts from a keyframe after its welcome.
    const read = createSnapshotReader();
    lastHeard = performance.now();
    socket.addEventListener("open", () => {
      // Closed before it opened: never say hello (a hello joins, and leaving saves a life).
      if (ws !== socket) return;
      sayHello(socket);
    });
    socket.addEventListener("message", (e) => {
      if (ws !== socket) return;
      lastHeard = performance.now();
      if (typeof e.data === "string") received += e.data.length;
      const wire: WireMessage | null = parseServerMessage(e.data);
      const m = wire && read(wire);
      if (!m) return;
      const on = mode.play;
      if (!on) {
        if (mode.watch) watching(mode.watch, socket, m);
        return;
      }
      if (m.t === WELCOME) {
        // A watch's welcome (you 0) still in flight after play() is not the player's.
        if (m.you === 0) return;
        firstBuild ??= m.build;
        attempt = 0;
        refusal = null;
        on.status(null);
      } else if (m.t === ERROR && m.code === ERROR_FULL) {
        // The reply to the watch this socket sent before play(): the server closes it, and the
        // close rejoins with the hello. Only a watch is ever refused as full.
        return;
      } else if (m.t === ERROR && m.code === ERROR_BUILD) {
        // Only a rejoin carries a build, so a first join can never loop on reloads.
        return outdated(on, socket, m.build ?? "");
      } else if (m.t === ERROR && m.code === ERROR_VERSION && firstBuild !== null) {
        // A rejoin to a server that no longer speaks this page's protocol: a redeploy. (On the very
        // first connect it stays final below, so a stale cache can't loop on reloads.)
        return outdated(on, socket, "");
      } else if (m.t === ERROR && refusalStatus(m.code) !== null) {
        // The server's limits: say so, and keep saying it through the close and the retries.
        refusal = refusalStatus(m.code);
        on.status(refusal);
      } else if (m.t === ERROR && isFinalError(m.code)) {
        final = true;
        if (m.code === ERROR_VERSION) on.status("Reload to update");
        else on.refused(m.code);
      }
      on.message(m);
    });
    socket.addEventListener("close", () => drop(socket));
  };

  mode.play?.status("Connecting...");
  open();
  const silence = setInterval(() => {
    const socket = ws;
    if (!socket || !serverSilent(lastHeard, performance.now())) return;
    drop(socket);
    socket.close();
  }, 1000);
  const conn: WatchConnection = {
    send(message) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(message);
    },
    get open() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
    get received() {
      return received;
    },
    close() {
      final = true;
      if (pending) clearTimeout(pending);
      pending = null;
      clearInterval(silence);
      if (rejoin) clearTimeout(rejoin);
      rejoin = null;
      const socket = ws;
      ws = null;
      socket?.close();
    },
    play(hello, on) {
      if (final || mode.play) throw new Error("play() needs a watching connection that is still open");
      mode.hello = hello;
      mode.play = on;
      mode.watch = null;
      attempt = 0;
      on.status("Connecting...");
      const socket = ws;
      if (socket && socket.readyState === WebSocket.OPEN) {
        pending = setTimeout(() => {
          pending = null;
          if (ws === socket && !final) sayHello(socket);
        }, 0);
      } else if (!socket) {
        // Between rejoins: rejoin now, as the player.
        if (rejoin) clearTimeout(rejoin);
        open();
      }
      // A socket still connecting says the hello when it opens.
      return conn;
    },
  };
  return conn;
}
