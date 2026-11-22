// The start screen's watching connection (#79) end to end, in-process (no spawned processes:
// #41): the browser's own connection (src/web/arena/net.ts watchArena) against the real server on
// an ephemeral port, then handed to the arena with play().
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ServerMessage, Welcome } from "../../shared/arena/protocol";
import { watchArena, type PlayHandlers, type WatchConnection } from "../../web/arena/net";
import { computeStats, openDb } from "../db";
import { startServer, type RunningServer, type ServerOptions } from "../serve";

const TIMEOUT = 15_000;
const KEY = "d".repeat(32);

let dir: string;
let db: Database;
let srv: RunningServer | null;
let conn: WatchConnection | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-watch-test-"));
  db = openDb(join(dir, "app.db"));
  srv = null;
  conn = null;
});

afterEach(async () => {
  conn?.close();
  await srv?.stop();
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

/** Starts the real server on `port` (0: any), retrying briefly while the port is still being released. */
async function start(extra: Partial<ServerOptions> = {}, port = 0): Promise<RunningServer> {
  for (let i = 0; ; i++) {
    try {
      return startServer({ port, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId: "a", ...extra });
    } catch (err) {
      if (i >= 20) throw err;
      await Bun.sleep(50);
    }
  }
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT - 3000;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

const url = (s: RunningServer) => `ws://127.0.0.1:${s.server.port}/ws`;

/** The start screen's connection, recording what it is told. */
function watch(s: RunningServer) {
  const got: ServerMessage[] = [];
  const told = { dropped: 0, unavailable: 0 };
  conn = watchArena(
    {
      message: (m) => void got.push(m),
      dropped: () => void told.dropped++,
      unavailable: () => void told.unavailable++,
    },
    url(s),
  );
  return { got, told };
}

/** The arena's handlers for play(), recording what it is told. */
function player() {
  const got: ServerMessage[] = [];
  const statuses: (string | null)[] = [];
  const newBuilds: string[] = [];
  const on: PlayHandlers = {
    message: (m) => void got.push(m),
    status: (t) => void statuses.push(t),
    refused: (code) => {
      throw new Error(`refused: ${code}`);
    },
    newBuild: (b) => void newBuilds.push(b),
  };
  return { on, got, statuses, newBuilds, welcomes: () => got.filter((m): m is Welcome => m.t === "welcome") };
}

const hello = { name: "Watcher", team: "tabs", player: KEY, touch: () => false };

test(
  "a watching connection plays on the same socket: a player welcome, one socket on the server, out of the demo arena",
  async () => {
    srv = await start();
    const w = watch(srv);
    await until("demo snapshots", () => w.got.some((m) => m.t === "snapshot"));
    expect(w.got[0]).toMatchObject({ t: "welcome", you: 0, arena: 1 });
    const p = player();
    conn!.play(hello, p.on);
    await until("the player's welcome", () => p.welcomes().length === 1);
    const welcome = p.welcomes()[0]!;
    expect(welcome.you).toBeGreaterThan(0);
    expect(welcome.arena).toBe(2);
    expect(p.statuses.at(-1)).toBe(null);
    await until("the demo arena closed", () => srv!.rooms.stats().arenas.length === 1);
    expect(srv.rooms.stats()).toMatchObject({ players: 1, watchers: 0 });
    expect(srv.server.pendingWebSockets).toBe(1);
    // Nothing more reaches the start screen's handlers.
    const seen = w.got.length;
    await until("the player's snapshots", () => p.got.filter((m) => m.t === "snapshot").length > 5);
    expect(w.got.length).toBe(seen);
  },
  TIMEOUT,
);

test(
  "play() then close() in the same turn (StrictMode's unmount) joins nobody and saves no life",
  async () => {
    srv = await start();
    const w = watch(srv);
    await until("the watch welcome", () => w.got.some((m) => m.t === "welcome"));
    conn!.play(hello, player().on);
    conn!.close();
    await until("the socket gone", () => srv!.server.pendingWebSockets === 0);
    await Bun.sleep(100);
    expect(srv.rooms.stats()).toMatchObject({ arenas: [], players: 0, watchers: 0 });
    await srv.stop();
    expect(computeStats(db).finishedRuns).toBe(0);
  },
  TIMEOUT,
);

test(
  "a full server: the watch is unavailable once and never retries",
  async () => {
    srv = await start({ arenaWatchers: 0 });
    const w = watch(srv);
    await until("unavailable", () => w.told.unavailable === 1);
    await Bun.sleep(800);
    expect(w.told).toEqual({ dropped: 0, unavailable: 1 });
    expect(conn!.open).toBe(false);
    expect(w.got).toEqual([]);
  },
  TIMEOUT,
);

test(
  "a watch rides out a redeploy quietly; playing after a redeploy to a new build reports the new build (the page reloads) and joins nobody",
  async () => {
    srv = await start();
    const port = srv.server.port!;
    const w = watch(srv);
    await until("the watch welcome", () => w.got.some((m) => m.t === "welcome"));
    await srv.stop();
    await until("dropped", () => w.told.dropped >= 1);
    srv = await start({ buildId: "b" }, port);
    await until("a welcome from the new server", () => w.got.filter((m) => m.t === "welcome").length === 2);
    expect(w.told.unavailable).toBe(0);
    const p = player();
    conn!.play(hello, p.on);
    await until("the new build reported", () => p.newBuilds.length === 1);
    expect(p.newBuilds).toEqual(["b"]);
    expect(p.welcomes()).toEqual([]);
    await until("the socket gone", () => srv!.server.pendingWebSockets === 0);
    await srv.stop();
    expect(computeStats(db).finishedRuns).toBe(0);
  },
  TIMEOUT,
);
