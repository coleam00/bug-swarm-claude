// The /ws endpoint's WebSocket handlers (Bun's built-in WebSocket). A socket must say hello
// within HELLO_TIMEOUT_MS: its name passes rules.ts and is not a bot name, its team is a team or
// "" and its protocol version matches, else it gets an `error` and is closed. The server decides
// the team (#131): the one stored for the player (`teamOf`) wins, else the hello's, else the team
// with fewer people playing now (rules.ts pickTeam), picked in the same turn as the join so two
// joins in a row see each other. The welcome carries it. A rejoin carries the build
// id its page started with; one from another build gets `error build` (with this server's build)
// before it joins, so a page that is about to reload never starts, and saves, an empty life. After the welcome it sends
// inputs, at most INPUTS_PER_SECOND; the rest are dropped. Anything the validator refuses is
// dropped without closing the socket. The server pings every socket every PING_MS; one it has not
// heard from (a message or a pong) for SILENT_MS is dropped, so a peer that vanished without
// closing (a phone losing its network) does not keep a frozen robot in the arena. Bun's own
// idle timeout can't do this: the tick's snapshots keep it alive.
// A hidden name (`bun run hide`, or a stored name the word lists now refuse) is refused at hello,
// and every HIDE_SWEEP_MS the joined sockets are checked against it, off the tick: a name hidden
// mid-life gets the same `error name` and close, and leaving ends its life as a disconnect does.
// When the server stops (a redeploy), `restart` sends every socket `error restarting` and closes it
// (the lives were already ended, Rooms.endAll; see lives.ts countsAsLife); from then on any socket is refused the same
// way, so a quick reconnect can't join an arena on a server that is going away.
// A socket may `watch` instead of saying hello (#79, the start screen): it gets a welcome with
// `you: 0` and the arena's events and snapshots, takes no player slot, and its inputs are dropped.
// Over the watcher cap it gets `error full` and is closed: MAX_WATCHERS server-wide, and (#119)
// the address gate's watcher cap, MAX_WATCHERS_PER_ADDRESS from one client address, checked first
// so one address never takes a server-wide slot it may not use. `full`, not `limit`: the start
// screen shows the drawn backdrop and Play still opens a fresh socket (net.ts). A hello on a
// watching socket stops the watch (giving its address slot back) and joins as a player on the same
// socket, checked exactly like a first hello.
// A frame Bun drops (send returns 0) is reported back to the room, which makes that socket's next
// snapshot a keyframe (view.ts); -1 (queued under backpressure) is delivered late, not lost.
// Stream safety (#104): each socket carries its client's address (serve.ts, TRUST_PROXY_HOPS), and
// the address gate (gate.ts) caps the sockets open and the joins per minute from one address. A
// socket over the cap gets `error limit` and a close as it opens (Bun runs the close handler inside
// that close, so it leaves at once, reading or not: measured on Windows and Linux). A hello is refused with `busy` while MAX_PEOPLE play (Rooms.full),
// checked before the join limit so a page retrying `busy` spends none of its address's joins, then
// with `limit` past the joins per minute. A socket whose send buffer stays over `slowBytes` for
// `slowMs` (a client that stopped reading) is terminated by the same ping timer, so nothing runs
// per tick; meanwhile Bun drops frames past MAX_SEND_BUFFER_BYTES, so its memory stays bounded.
// A joined socket says when its tab is hidden or shown (`visibility`, #117), read before the input
// limiter so a dropped "shown" can never leave a player uncounted. A play press from a member moved
// away to free a slot joins them again (Rooms.input), maybe in another arena: the socket then
// belongs to that arena and entity, so its close leaves the right one. The page counts its inputs
// from 1 again after that welcome, so inputs numbered above the press (sent before the welcome
// reached it) are dropped until one at or below it arrives: they would make the new ones look old,
// and a second press in flight would dash the new robot.
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import {
  ERROR,
  ERROR_BUILD,
  ERROR_BUSY,
  ERROR_FULL,
  ERROR_HELLO,
  ERROR_LIMIT,
  ERROR_NAME,
  ERROR_RESTARTING,
  ERROR_TEAM,
  ERROR_VERSION,
  HELLO,
  VISIBILITY,
  WATCH,
  parseClientMessage,
  type ErrorCode,
  type Hello,
} from "../../shared/arena/protocol";
import { checkName, isBotName, isTeam, pickTeam, TEAMS, type Team } from "../rules";
import { createOpenGate, type AddressGate } from "./gate";
import { createInputLimiter, type InputLimiter } from "./limiter";
import type { Rooms } from "./rooms";

/** A socket that has not said hello by then is closed. */
export const HELLO_TIMEOUT_MS = 5000;
/** Frames over this are closed by Bun itself; 1 KiB to 4 KiB is dropped by the validator. */
export const MAX_FRAME_BYTES = 4096;
/** How often the server pings each socket, ms. Browsers answer pings even in hidden tabs, so a hidden tab comes from the page (`visibility`, #117). */
export const PING_MS = 5000;
/** A socket silent (no message, no pong) for longer than this is dropped, ms. */
export const SILENT_MS = 15_000;
/** The WebSocket close code for a refused hello (policy violation). */
export const CLOSE_REFUSED = 1008;
/** The WebSocket close code for a server restarting (a redeploy): come back later. */
export const CLOSE_RESTARTING = 1012;
/** How often joined sockets are checked for a name hidden since they joined, ms. */
export const HIDE_SWEEP_MS = 2000;
/** A send buffer over this many bytes means the client is not reading. Real snapshots are 5-27 KB/s. */
export const SLOW_BUFFER_BYTES = 256 * 1024;
/** A socket whose send buffer stays over SLOW_BUFFER_BYTES this long is dropped, ms: within SLOW_DROP_MS + PING_MS (15 s) of its buffer crossing the bound (the OS's own socket buffers fill first). */
export const SLOW_DROP_MS = 10_000;
/** Bun's per-socket backpressure limit: past it, frames are dropped (send returns 0) instead of queued. */
export const MAX_SEND_BUFFER_BYTES = 1024 * 1024;
/** How many admitted sockets after boot log their client address, so the operator can check TRUST_PROXY_HOPS. */
export const LOGGED_SOCKETS = 20;
/** A `busy` refusal is logged at most this often, server-wide, ms. */
const BUSY_LOG_MS = 60_000;

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
  /** The watcher id while the socket watches an arena (Rooms.watch), else null. */
  watcher: number | null;
  /** The client's address (serve.ts, pickClientIp), which the address gate counts by. */
  address: string;
  /** True once the address gate counted this socket; its close gives the slot back. */
  counted: boolean;
  /**
   * True while the address gate counts this socket as a watcher. Its own flag, not `watcher`:
   * restart nulls `watcher` before the close, which must still give the slot back.
   */
  watchCounted: boolean;
  /** Since when its send buffer has been over the slow bound, ms, or null. */
  slowSince: number | null;
  /** After a move-away return (#117): inputs numbered above this are from before the welcome, dropped. Else null. */
  staleAbove: number | null;
};

/** The data a new socket starts with, passed to server.upgrade, with its client's address. */
export function newSocketData(address = ""): SocketData {
  return {
    limiter: createInputLimiter(),
    room: null,
    entity: null,
    helloTimer: null,
    lastHeard: 0,
    liveTimer: null,
    name: null,
    watcher: null,
    address,
    counted: false,
    watchCounted: false,
    slowSince: null,
    staleAbove: null,
  };
}

/**
 * How often to ping, when to give up on a silent socket, and on one that stopped reading (its send
 * buffer over `slowBytes` for `slowMs`); the defaults are the real ones, tests shorten them.
 */
export type Liveness = { pingMs: number; silentMs: number; slowBytes?: number; slowMs?: number };

export type ArenaSocketOptions = {
  now?: () => number;
  liveness?: Liveness;
  /** True for a name that may not play (hidden from the boards). Defaults to none. */
  isHidden?: (name: string) => boolean;
  /** How often joined sockets are checked with `isHidden`, ms; tests shorten it. */
  sweepMs?: number;
  /** The per-address limits (gate.ts); defaults to none (createOpenGate). serve.ts passes the real one. */
  gate?: AddressGate;
  /** The team stored for a player key, or null (none yet, or a new player). Defaults to none. */
  teamOf?: (playerKey: string) => Team | null;
  /** Each team's total, for a tie in the team pick (rules.ts pickTeam). Defaults to even. */
  teamTotals?: () => Record<Team, number>;
  /** Where the first admitted sockets' addresses, the refusals and the slow drops are written. Defaults to nowhere. */
  log?: (line: string) => void;
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
  const slowBytes = opts.liveness?.slowBytes ?? SLOW_BUFFER_BYTES;
  const slowMs = opts.liveness?.slowMs ?? SLOW_DROP_MS;
  const gate = opts.gate ?? createOpenGate();
  const log = opts.log ?? (() => {});
  /** Admitted sockets logged so far (LOGGED_SOCKETS). */
  let logged = 0;
  let busyLoggedAt = -Infinity;
  const isHidden = opts.isHidden ?? (() => false);
  const teamOf = opts.teamOf ?? (() => null);
  const totals = opts.teamTotals ?? (() => Object.fromEntries(TEAMS.map((t) => [t, 0])) as Record<Team, number>);
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

  /** At most one line per address per minute (the gate's), so a flood can't flood the log too. */
  const logRefusal = (ws: ServerWebSocket<SocketData>, why: string) => {
    if (gate.shouldLog(ws.data.address)) log(`ws refused (${why}): client ${ws.data.address}`);
  };

  /** Gives the address gate's watcher slot back, once. */
  const releaseWatch = (ws: ServerWebSocket<SocketData>) => {
    if (ws.data.watchCounted) gate.unwatch(ws.data.address);
    ws.data.watchCounted = false;
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
    if (m.build !== "" && m.build !== rooms.buildId) {
      ws.send(JSON.stringify({ t: ERROR, code: ERROR_BUILD, build: rooms.buildId }));
      return ws.close(CLOSE_REFUSED, ERROR_BUILD);
    }
    const name = checkName(m.name);
    if (!name.ok || isBotName(name.name) || isHidden(name.name)) return refuse(ws, ERROR_NAME);
    if (m.team !== "" && !isTeam(m.team)) return refuse(ws, ERROR_TEAM);
    // The people cap before the join limit: a page retrying `busy` spends none of its joins.
    if (rooms.full) {
      const t = now();
      if (t - busyLoggedAt >= BUSY_LOG_MS) {
        busyLoggedAt = t;
        log(`ws refused (server full of people): client ${ws.data.address}`);
      }
      return refuse(ws, ERROR_BUSY);
    }
    if (!gate.join(ws.data.address)) {
      logRefusal(ws, "joins per minute");
      return refuse(ws, ERROR_LIMIT);
    }
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    // A watching socket becomes a player: no more watcher frames after the welcome below.
    if (ws.data.watcher !== null) rooms.unwatch(ws.data.watcher);
    ws.data.watcher = null;
    releaseWatch(ws);
    const team = teamOf(m.player) ?? (isTeam(m.team) ? m.team : pickTeam(rooms.playingByTeam(), totals));
    const entered = rooms.join(name.name, team, { playerKey: m.player, touch: m.touch }, (msg) => ws.send(msg) !== 0);
    ws.data.room = entered.room;
    ws.data.entity = entered.entity;
    ws.data.name = name.name;
    ws.send(JSON.stringify(entered.welcome));
    joined.add(ws);
    if (!sweepTimer) sweepTimer = setInterval(sweep, sweepMs);
  };

  const watch = (ws: ServerWebSocket<SocketData>, v: number) => {
    if (v !== PROTOCOL_VERSION) return refuse(ws, ERROR_VERSION);
    if (!gate.watch(ws.data.address)) {
      logRefusal(ws, "watchers");
      return refuse(ws, ERROR_FULL);
    }
    ws.data.watchCounted = true;
    const watching = rooms.watch((msg) => ws.send(msg) !== 0);
    if (!watching) {
      // The server-wide cap: the address's slot goes back before the refusal's close.
      releaseWatch(ws);
      return refuse(ws, ERROR_FULL);
    }
    if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
    ws.data.helloTimer = null;
    ws.data.watcher = watching.watcher;
    ws.send(JSON.stringify(watching.welcome));
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
        ws.data.watcher = null;
        sendRestarting(ws);
      }
    },
    get openCount() {
      return all.size;
    },
    maxPayloadLength: MAX_FRAME_BYTES,
    backpressureLimit: MAX_SEND_BUFFER_BYTES,
    open(ws) {
      all.add(ws);
      if (restarting) return sendRestarting(ws);
      const address = ws.data.address;
      if (!gate.open(address)) {
        logRefusal(ws, "sockets open");
        return refuse(ws, ERROR_LIMIT);
      }
      ws.data.counted = true;
      if (logged < LOGGED_SOCKETS) log(`ws ${++logged}/${LOGGED_SOCKETS} after boot: client ${address}`);
      ws.data.helloTimer = setTimeout(() => refuse(ws, ERROR_HELLO), HELLO_TIMEOUT_MS);
      ws.data.lastHeard = now();
      ws.data.liveTimer = setInterval(() => {
        const t = now();
        // terminate, not close: a vanished peer never answers the close handshake, and one that
        // stopped reading never reads it.
        if (t - ws.data.lastHeard > silentMs) return ws.terminate();
        if (ws.getBufferedAmount() > slowBytes) {
          ws.data.slowSince ??= t;
          if (t - ws.data.slowSince >= slowMs) {
            log(`ws dropped (not reading: over ${slowBytes} bytes unsent for ${slowMs} ms): client ${address}`);
            return ws.terminate();
          }
        } else ws.data.slowSince = null;
        ws.ping();
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
      if (m.t === WATCH) {
        if (restarting) sendRestarting(ws);
        else if (room === null && ws.data.watcher === null) watch(ws, m.v);
        return;
      }
      if (room === null || entity === null) return;
      if (m.t === VISIBILITY) return rooms.visibility(room, entity, m.hidden);
      if (!ws.data.limiter.allow(now())) return;
      if (ws.data.staleAbove !== null) {
        if (m.seq > ws.data.staleAbove) return;
        ws.data.staleAbove = null;
      }
      const back = rooms.input(room, entity, { seq: m.seq, mx: m.mx, my: m.my, aim: m.aim, fire: m.fire, dash: m.dash, grenade: m.grenade });
      if (back) {
        ws.data.room = back.room;
        ws.data.entity = back.entity;
        ws.data.staleAbove = m.seq;
      }
    },
    close(ws) {
      all.delete(ws);
      joined.delete(ws);
      if (joined.size === 0) stopSweep();
      if (ws.data.helloTimer) clearTimeout(ws.data.helloTimer);
      ws.data.helloTimer = null;
      if (ws.data.liveTimer) clearInterval(ws.data.liveTimer);
      ws.data.liveTimer = null;
      // Every way a socket ends (a refusal, restart, terminate, the client) comes through here once.
      if (ws.data.counted) gate.close(ws.data.address);
      ws.data.counted = false;
      if (ws.data.room !== null && ws.data.entity !== null) rooms.leave(ws.data.room, ws.data.entity);
      if (ws.data.watcher !== null) rooms.unwatch(ws.data.watcher);
      releaseWatch(ws);
      ws.data.room = null;
      ws.data.entity = null;
      ws.data.watcher = null;
    },
  };
}
