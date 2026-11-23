// A redeploy end to end, in-process (no spawned processes: #41): the browser's own connection
// (src/web/arena/net.ts) against the real server, which is stopped and started again on the same
// port, first with the same build id, then with a new one.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ERROR, ERROR_VERSION, type ServerMessage, type Welcome } from "../../shared/arena/protocol";
import { connectArena, type Connection } from "../../web/arena/net";
import { computeStats, openDb, playerBest } from "../db";
import { startServer, type RunningServer } from "../serve";

const TIMEOUT = 15_000;
const KEY = "c".repeat(32);

let dir: string;
let db: Database;
let srv: RunningServer | null;
let other: ReturnType<typeof Bun.serve> | null;
let conn: Connection | null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-redeploy-test-"));
  db = openDb(join(dir, "app.db"));
  srv = null;
  other = null;
  conn = null;
});

afterEach(async () => {
  conn?.close();
  await srv?.stop();
  await other?.stop(true);
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

/** Starts the real server with `buildId` on `port` (0: any), retrying briefly while the port is still being released. */
async function start(buildId: string, port = 0): Promise<RunningServer> {
  for (let i = 0; ; i++) {
    try {
      return startServer({ port, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId });
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

/** Gives the client's life in progress points, so the stop that cuts it saves it (a 0-point life under 5 s is not saved: #114). */
function score(s: RunningServer, welcome: Welcome, points: number): void {
  s.rooms.room(welcome.arena)!.state.players.find((p) => p.id === welcome.you)!.score = points;
}

/** The browser's connection, as game.ts opens it, recording what it is told. */

function joinArena(url: string) {
  const welcomes: Welcome[] = [];
  const statuses: (string | null)[] = [];
  const newBuilds: string[] = [];
  const messages: ServerMessage[] = [];
  conn = connectArena(
    { name: "Redeployed", team: "tabs", player: KEY, touch: () => false },
    {
      message: (m) => {
        messages.push(m);
        if (m.t === "welcome") welcomes.push(m);
      },
      status: (s) => void statuses.push(s),
      refused: (code) => {
        throw new Error(`refused: ${code}`);
      },
      newBuild: (b) => void newBuilds.push(b),
    },
    url,
  );
  return { welcomes, statuses, newBuilds, messages };
}

test(
  "a client rejoins a restarted server by itself, and is told when the build changed",
  async () => {
    srv = await start("a");
    const port = srv.server.port!;
    const c = joinArena(`ws://127.0.0.1:${port}/ws`);
    await until("the first welcome", () => c.welcomes.length === 1);
    expect(c.welcomes[0]!.build).toBe("a");

    // A redeploy of the same build: the client says so, rejoins with no help, and plays on.
    score(srv, c.welcomes[0]!, 7);
    expect(await srv.stop()).toBe(1);
    await until("the restarting error", () => c.messages.some((m) => m.t === "error"));
    expect(c.messages.at(-1)).toEqual({ t: "error", code: "restarting" });
    expect(c.statuses.at(-1)).toBe("Reconnecting...");
    srv = await start("a", port);
    await until("the second welcome", () => c.welcomes.length === 2);
    expect(c.welcomes[1]!.build).toBe("a");
    expect(c.statuses.at(-1)).toBe(null);
    expect(c.newBuilds).toEqual([]);
    // The life cut by the first stop was saved, and its player is the one that rejoined.
    expect(playerBest(db, KEY)).toBe(7);

    // A redeploy of a new build: the client is told, and does not play on the old page.
    score(srv, c.welcomes[1]!, 3);
    expect(await srv.stop()).toBe(1);
    const runs = computeStats(db).finishedRuns;
    expect(runs).toBe(2);
    srv = await start("b", port);
    await until("the new build reported", () => c.newBuilds.length === 1);
    expect(c.newBuilds).toEqual(["b"]);
    expect(c.statuses.at(-1)).toBe("Updating...");
    expect(c.welcomes.length).toBe(2);
    expect(conn!.open).toBe(false);
    // It was refused before it joined: no arena opened, so no empty life is saved.
    expect(srv.rooms.stats().arenas).toEqual([]);
    await srv.stop();
    expect(computeStats(db).finishedRuns).toBe(runs);
  },
  TIMEOUT,
);

test(
  "a rejoin refused for its protocol version (the new build changed it) is a new build, not a dead end",
  async () => {
    srv = await start("a");
    const port = srv.server.port!;
    const c = joinArena(`ws://127.0.0.1:${port}/ws`);
    await until("the first welcome", () => c.welcomes.length === 1);
    await srv.stop();
    srv = null;
    // The new server speaks another version: it refuses this page's hello.
    for (let i = 0; !other; i++) {
      try {
        other = Bun.serve({
          port,
          hostname: "127.0.0.1",
          fetch: (req, s) => (s.upgrade(req, { data: null }) ? undefined : new Response("no", { status: 426 })),
          websocket: {
            message(ws) {
              ws.send(JSON.stringify({ t: ERROR, code: ERROR_VERSION }));
              ws.close(1008, ERROR_VERSION);
            },
          },
        });
      } catch (err) {
        if (i >= 20) throw err;
        await Bun.sleep(50);
      }
    }
    await until("the new build reported", () => c.newBuilds.length === 1);
    expect(c.newBuilds).toEqual([""]);
    expect(c.statuses).not.toContain("Reload to update");
  },
  TIMEOUT,
);
