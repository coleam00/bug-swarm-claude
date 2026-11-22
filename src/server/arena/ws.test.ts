// The arena over real WebSockets: the real server (startServer) on an ephemeral port, real
// clients, everything closed before each test ends (no spawned processes: #41).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { HITS_PER_LIFE, MAX_PLAYERS_PER_ARENA, PICKUP_IDS, PROTOCOL_VERSION, REVIVE_POINTS } from "../../shared/arena/constants";
import { placeBug, placePickup } from "../../shared/arena/testkit";
import { encodeHello, encodeInput, type ServerMessage, type Snapshot, type Welcome } from "../../shared/arena/protocol";
import { computeStats, findPlayer, hideName, openDb, playerBest, teamTotals } from "../db";
import { TOP_CACHE_MS } from "../app";
import { startServer, type RunningServer } from "../serve";
import { HIDE_SWEEP_MS as REAL_HIDE_SWEEP_MS } from "./sockets";
import type { ArenaStats } from "./rooms";

const TIMEOUT = 15_000;
/** Liveness shortened for the tests: ping every 100 ms, drop after 600 ms of silence. */
const LIVENESS = { pingMs: 100, silentMs: 600 };
/** The hidden-name sweep, shortened for the tests. */
const HIDE_SWEEP_MS = 50;

let dir: string;
let db: Database;
let srv: RunningServer;
let clients: Client[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-ws-test-"));
  db = openDb(join(dir, "app.db"));
  srv = startServer({ port: 0, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId: "test", liveness: LIVENESS, hideSweepMs: HIDE_SWEEP_MS, arenaFill: 0 });
  clients = [];
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.stop();
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

type Client = {
  got: ServerMessage[];
  closed: Promise<number>;
  isClosed: () => boolean;
  send: (m: string | Uint8Array) => void;
  waitFor: <T>(what: string, find: () => T | null | undefined | false) => Promise<T>;
  close: () => Promise<void>;
};

async function connect(): Promise<Client> {
  const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
  const got: ServerMessage[] = [];
  let closedFlag = false;
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => {
      closedFlag = true;
      resolve(e.code);
    }),
  );
  ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data)) as ServerMessage));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
  });
  const client: Client = {
    got,
    closed,
    isClosed: () => closedFlag,
    send: (m) => ws.send(m),
    async waitFor(what, find) {
      const deadline = Date.now() + TIMEOUT - 2000;
      for (;;) {
        const v = find();
        if (v) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
      }
    },
    async close() {
      if (!closedFlag) ws.close();
      await closed;
    },
  };
  clients.push(client);
  return client;
}

let nextPlayer = 0;
const playerId = () => (nextPlayer++).toString(16).padStart(32, "0");
const hello = (name: string, team = "tabs", v = PROTOCOL_VERSION) => encodeHello(v, name, team, playerId(), false);

async function enter(name: string, team = "tabs"): Promise<{ c: Client; welcome: Welcome }> {
  const c = await connect();
  c.send(hello(name, team));
  const welcome = await c.waitFor("welcome", () => c.got.find((m): m is Welcome => m.t === "welcome"));
  return { c, welcome };
}

/** Where `id` was in the latest snapshot `c` received. */
function xOf(c: Client, id: number): number | null {
  for (let i = c.got.length - 1; i >= 0; i--) {
    const m = c.got[i]!;
    if (m.t === "snapshot") return (m as Snapshot).p.find((p) => p[0] === id)?.[1] ?? null;
  }
  return null;
}

/** Sends mx = 1 inputs at 20 Hz until `until` resolves. */
async function walkRight(c: Client, until: Promise<unknown>): Promise<void> {
  let seq = 0;
  let done = false;
  void until.finally(() => (done = true));
  while (!done) {
    c.send(encodeInput({ seq: ++seq, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    await Bun.sleep(50);
  }
}

async function seesMove(mover: { c: Client; welcome: Welcome }, watcher: Client): Promise<void> {
  const id = mover.welcome.you;
  const x0 = await watcher.waitFor("the mover in a snapshot", () => xOf(watcher, id));
  const moved = watcher.waitFor("the mover's x to rise 150 units", () => (xOf(watcher, id) ?? x0) - x0 > 150);
  await Promise.all([moved, walkRight(mover.c, moved)]);
}

test(
  "two players in one arena each see the other move",
  async () => {
    const a = await enter("Ada", "tabs");
    const b = await enter("Bob", "spaces");
    expect(b.welcome.arena).toBe(a.welcome.arena);
    expect(b.welcome.roster).toEqual([
      { id: a.welcome.you, name: "Ada", team: "tabs" },
      { id: b.welcome.you, name: "Bob", team: "spaces" },
    ]);
    await a.c.waitFor("Bob's join event", () => a.c.got.some((m) => m.t === "event" && m.kind === "join" && m.id === b.welcome.you));
    await seesMove(a, b.c);
    await seesMove(b, a.c);
    // Ada's own snapshots acknowledge her inputs.
    expect(a.c.got.some((m) => m.t === "snapshot" && m.ack > 0)).toBe(true);
  },
  TIMEOUT,
);

test(
  "the 21st player lands in a second arena, and the stats say so",
  async () => {
    const joined = [];
    for (let i = 0; i < MAX_PLAYERS_PER_ARENA + 1; i++) joined.push(await enter(`p${String(i).padStart(2, "0")}`));
    expect(joined.slice(0, MAX_PLAYERS_PER_ARENA).every((j) => j.welcome.arena === 1)).toBe(true);
    expect(joined[MAX_PLAYERS_PER_ARENA]!.welcome.arena).toBe(2);
    const stats = (await (await fetch(`${srv.url}/api/arena/stats`)).json()) as ArenaStats;
    expect(stats.arenas).toEqual([
      { id: 1, players: 20, bots: 0 },
      { id: 2, players: 1, bots: 0 },
    ]);
    expect(stats.players).toBe(21);
    await joined[0]!.c.waitFor("a tick time", () => srv.rooms.stats().tick.p50 !== null);
    // Leaving closes the second arena.
    await joined[MAX_PLAYERS_PER_ARENA]!.c.close();
    await joined[0]!.c.waitFor("arena 2 closed", () => srv.rooms.stats().arenas.length === 1);
  },
  TIMEOUT,
);

test(
  "with the default fill, one player alone is topped up with 3 server bots, and the stats count them apart",
  async () => {
    // This test's server keeps the default fill (the others pass arenaFill: 0).
    await srv.stop();
    srv = startServer({ port: 0, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId: "test", liveness: LIVENESS });
    const a = await enter("Ada", "tabs");
    expect(a.welcome.roster).toEqual([{ id: a.welcome.you, name: "Ada", team: "tabs" }]);
    const four = await a.c.waitFor("a snapshot with 4 players", () => a.c.got.find((m): m is Snapshot => m.t === "snapshot" && m.p.length === 4));
    const names = a.c.got.filter((m) => m.t === "event" && m.kind === "join").map((m) => (m as { name: string }).name);
    expect(names).toEqual(["bot Ada", "bot Linus", "bot Grace"]);
    expect(four.p.map((p) => p[0]).sort((x, y) => x - y)).toEqual([a.welcome.you, a.welcome.you + 1, a.welcome.you + 2, a.welcome.you + 3]);
    const stats = (await (await fetch(`${srv.url}/api/arena/stats`)).json()) as ArenaStats;
    expect(stats).toMatchObject({ arenas: [{ id: 1, players: 1, bots: 3 }], players: 1, bots: 3 });
    // The stream board reads the same rooms (serve.ts wires them in) and counts the person only (#74).
    const board = (await (await fetch(`${srv.url}/api/board`)).json()) as { playing: number; arenas: unknown[] };
    expect(board).toMatchObject({ playing: 1, arenas: [{ id: a.welcome.arena, players: 1, wave: 1 }] });
  },
  TIMEOUT,
);

test(
  "a bot name, a bad team or another protocol version gets an error and the socket closes",
  async () => {
    for (const [msg, code] of [
      [hello("bot alice"), "name"],
      [hello("BOT  Bob"), "name"],
      [hello("x"), "name"],
      [hello("Robo", "tab"), "team"],
      [hello("Robo", "tabs", PROTOCOL_VERSION + 1), "version"],
    ] as const) {
      const c = await connect();
      c.send(msg);
      expect(await c.closed).toBe(1008);
      expect(c.got).toEqual([{ t: "error", code }]);
    }
    expect(srv.rooms.stats().players).toBe(0);
  },
  TIMEOUT,
);

test(
  "a hidden name is refused at hello",
  async () => {
    hideName(db, "Hidden One", new Date());
    const c = await connect();
    c.send(hello("hidden one"));
    expect(await c.closed).toBe(1008);
    expect(c.got).toEqual([{ t: "error", code: "name" }]);
    expect(srv.rooms.stats().players).toBe(0);
  },
  TIMEOUT,
);

test("the real hide sweep and hidden-name cache together kick a hidden name within 5 s (#64)", () => {
  expect(REAL_HIDE_SWEEP_MS + TOP_CACHE_MS).toBeLessThanOrEqual(5000);
});

test(
  "a name hidden mid-life is kicked from its arena within the sweep and the cache, and its peers see it leave",
  async () => {
    const kicked = await enter("Kick Me");
    const peer = await enter("Stays");
    const id = kicked.welcome.you;
    await kicked.c.waitFor("a snapshot", () => kicked.c.got.some((m) => m.t === "snapshot"));
    const at = Date.now();
    hideName(db, "kick me", new Date());
    expect(await kicked.c.closed).toBe(1008);
    // The hidden-name cache (1 s) plus one sweep (50 ms here), with slack.
    expect(Date.now() - at).toBeLessThan(1600);
    expect(kicked.c.got.at(-1)).toEqual({ t: "error", code: "name" });
    await peer.c.waitFor("the leave", () => peer.c.got.some((m) => m.t === "event" && m.kind === "leave" && m.id === id));
    expect(peer.c.isClosed()).toBe(false);
    expect(srv.rooms.stats().players).toBe(1);
  },
  TIMEOUT,
);

test(
  "junk, oversized and early messages are dropped and the socket keeps playing",
  async () => {
    const c = await connect();
    // An input before hello is ignored.
    c.send(encodeInput({ seq: 1, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    c.send(hello("Robo"));
    await c.waitFor("welcome", () => c.got.some((m) => m.t === "welcome"));
    c.send("{not json");
    c.send(JSON.stringify({ t: "input", seq: 2, mx: "1" }));
    c.send(JSON.stringify({ t: "input", seq: 3, mx: 1, my: 0, aim: 0, fire: false, dash: false, pad: "x".repeat(2000) }));
    c.send(new Uint8Array([1, 2, 3]));
    // A second hello is ignored: still one player.
    c.send(hello("Other"));
    const seen = c.got.length;
    await c.waitFor("snapshots after the junk", () => c.got.slice(seen).filter((m) => m.t === "snapshot").length >= 3);
    expect(c.isClosed()).toBe(false);
    expect(srv.rooms.stats().players).toBe(1);
    // None of the junk inputs was applied.
    const acks = c.got.filter((m): m is Snapshot => m.t === "snapshot").map((m) => m.ack);
    expect(acks.every((a) => a === 0)).toBe(true);
  },
  TIMEOUT,
);

test(
  "a socket sending more than 30 inputs a second has the rest dropped, and stays open",
  async () => {
    const { c } = await enter("Burst");
    // 60 inputs at once: the first 30 pass the limiter; the queue keeps the newest 4 of those.
    for (let seq = 1; seq <= 60; seq++) c.send(encodeInput({ seq, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
    const seen = c.got.length;
    await c.waitFor("10 snapshots after the burst", () => c.got.slice(seen).filter((m) => m.t === "snapshot").length >= 10);
    const acks = c.got.filter((m): m is Snapshot => m.t === "snapshot").map((m) => m.ack);
    expect(Math.max(...acks)).toBe(30);
    expect(c.isClosed()).toBe(false);
  },
  TIMEOUT,
);

const END = "\r\n\r\n";

/**
 * A raw TCP WebSocket client that does the handshake and sends a hello, then never reads a frame
 * or answers a ping: a peer that vanished without closing (a phone that lost its network).
 */
async function ghost(name: string): Promise<{ end: () => void }> {
  const url = new URL(srv.url);
  const handshake = new Promise<void>((resolve) => {
    let got = "";
    void Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: {
        open(sock) {
          sock.write(
            `GET /ws HTTP/1.1\r\nHost: ${url.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
          ghostSocket = sock;
        },
        data(sock, chunk) {
          if (got.includes(END)) return; // after the handshake: read nothing, answer nothing
          got += chunk.toString("latin1");
          if (!got.includes(END)) return;
          // One masked text frame (client frames must be masked) carrying the hello.
          const payload = new TextEncoder().encode(hello(name));
          const mask = [1, 2, 3, 4];
          const frame = new Uint8Array(2 + 4 + payload.length);
          frame[0] = 0x81;
          frame[1] = 0x80 | payload.length; // under 126 bytes
          frame.set(mask, 2);
          payload.forEach((b, i) => (frame[6 + i] = b ^ mask[i % 4]!));
          sock.write(frame);
          resolve();
        },
      },
    });
  });
  let ghostSocket: { end: () => void } | null = null;
  await handshake;
  return { end: () => ghostSocket?.end() };
}

test(
  "a socket that stops answering is dropped and its robot leaves; a quiet live client stays",
  async () => {
    const watcher = await enter("Watcher");
    // A live client that sends nothing after its hello: the browser answers pings for it.
    const quiet = await enter("Quiet");
    const g = await ghost("Ghost");
    try {
      await watcher.c.waitFor("the ghost to join", () => srv.rooms.stats().players === 3);
      const ghostId = watcher.c.got.find((m) => m.t === "event" && m.kind === "join" && m.name === "Ghost")!;
      expect(ghostId).toBeDefined();
      await watcher.c.waitFor("the ghost to be dropped", () =>
        watcher.c.got.some((m) => m.t === "event" && m.kind === "leave" && m.id === (ghostId as { id: number }).id),
      );
      expect(srv.rooms.stats().players).toBe(2);
      // Well past the silence limit, the quiet client is still in.
      await Bun.sleep(LIVENESS.silentMs * 3);
      expect(quiet.c.isClosed()).toBe(false);
      expect(srv.rooms.stats().players).toBe(2);
    } finally {
      g.end();
    }
  },
  TIMEOUT,
);

test(
  "a socket upgrade is required at /ws, and the rest of the server still answers",
  async () => {
    expect((await fetch(`${srv.url}/ws`)).status).toBe(426);
    expect(await (await fetch(`${srv.url}/health`)).text()).toBe("ok");
  },
  TIMEOUT,
);

test(
  "a life ended by leaving is saved as a run with the hello's player id, team and touch flag",
  async () => {
    const key = "f".repeat(32);
    const c = await connect();
    c.send(encodeHello(PROTOCOL_VERSION, "Toucher", "spaces", key, true));
    await c.waitFor("a snapshot", () => c.got.some((m) => m.t === "snapshot"));
    await c.close();
    await c.waitFor("the life saved", () => playerBest(db, key) !== null);
    expect(findPlayer(db, key)).toEqual({ name: "Toucher", team: "spaces" });
    expect(computeStats(db)).toMatchObject({ players: 1, finishedRuns: 1, touchShare: 100 });
    expect(teamTotals(db)).toEqual({ tabs: 0, spaces: 0 });
  },
  TIMEOUT,
);

test(
  "stopping the server (a redeploy) saves every life in progress with its score and tells every client it is restarting",
  async () => {
    const [ka, kb] = ["a".repeat(32), "b".repeat(32)];
    const a = await connect();
    const b = await connect();
    a.send(encodeHello(PROTOCOL_VERSION, "Ada", "tabs", ka, false));
    b.send(encodeHello(PROTOCOL_VERSION, "Bob", "spaces", kb, true));
    for (const c of [a, b]) await c.waitFor("a snapshot", () => c.got.some((m) => m.t === "snapshot"));
    // Ada has points mid-life.
    const room = srv.rooms.room(1)!;
    room.state.players.find((p) => p.name === "Ada")!.score = 85;
    expect(await srv.stop()).toBe(2);
    for (const c of [a, b]) {
      expect(await c.closed).toBe(1012);
      expect(c.got.at(-1)).toEqual({ t: "error", code: "restarting" });
    }
    // Saved before stop resolved: the caller closes the database next.
    expect([playerBest(db, ka), playerBest(db, kb)]).toEqual([85, 0]);
    expect(computeStats(db)).toMatchObject({ players: 2, finishedRuns: 2 });
    expect(srv.rooms.stats().arenas).toEqual([]);
    // A second stop (the afterEach) is the same stop.
    expect(await srv.stop()).toBe(2);
  },
  TIMEOUT,
);

/** Where `id` was in the latest snapshot `c` received. */
function posOf(c: Client, id: number): [number, number] | null {
  for (let i = c.got.length - 1; i >= 0; i--) {
    const m = c.got[i]!;
    if (m.t === "snapshot") {
      const row = (m as Snapshot).p.find((p) => p[0] === id);
      return row ? [row[1], row[2]] : null;
    }
  }
  return null;
}

const eventIndex = (c: Client, kind: string) => c.got.findIndex((m) => m.t === "event" && m.kind === kind);

test(
  "two clients: one goes down, the other walks over and revives it; both receive the events in order",
  async () => {
    const a = await enter("Ada", "tabs");
    const b = await enter("Bob", "spaces");
    const ida = a.welcome.you;
    const idb = b.welcome.you;
    const room = srv.rooms.room(a.welcome.arena)!;
    const pa = room.state.players.find((p) => p.id === ida)!;
    const pb = room.state.players.find((p) => p.id === idb)!;
    // Between ticks, on the server's own thread: Bob 150 units from Ada, no bugs but one placed on
    // Bob's last hit, and Ada untouchable for the walk.
    room.state.bugs.length = 0;
    pa.budget = 0;
    pb.budget = 0;
    pb.x = pa.x + 150;
    pb.y = pa.y;
    pb.vx = pb.vy = 0;
    pa.invulnTicks = 400;
    pb.invulnTicks = 0;
    pb.hits = HITS_PER_LIFE - 1;
    placeBug(room.state, pb.x - 5, pb.y);
    await Promise.all([a.c, b.c].map((c) => c.waitFor("Bob's down event", () => eventIndex(c, "down") >= 0)));
    // Ada walks over with real inputs, steering from her snapshots, and holds still once close.
    const revived = Promise.all([a.c, b.c].map((c) => c.waitFor("Bob's revive event", () => eventIndex(c, "revive") >= 0)));
    let done = false;
    void revived.finally(() => (done = true));
    let seq = 0;
    while (!done) {
      const me = posOf(a.c, ida);
      const him = posOf(a.c, idb);
      let mx = 0;
      let my = 0;
      if (me && him) {
        const dx = him[0] - me[0];
        const dy = him[1] - me[1];
        const d = Math.hypot(dx, dy);
        if (d > 35) {
          mx = dx / d;
          my = dy / d;
        }
      }
      a.c.send(encodeInput({ seq: ++seq, mx, my, aim: 0, fire: false, dash: false }));
      await Bun.sleep(50);
    }
    await revived;
    for (const c of [a.c, b.c]) {
      const down = eventIndex(c, "down");
      const revive = eventIndex(c, "revive");
      expect(down).toBeLessThan(revive);
      expect(c.got[down]).toEqual({ t: "event", kind: "down", id: idb });
      expect(c.got[revive]).toEqual({ t: "event", kind: "revive", id: idb, by: ida, points: REVIVE_POINTS });
    }
    // The first snapshot after the revive: Bob is up with one hit left, Ada has her 50.
    const after = (c: Client) => c.waitFor("a snapshot after the revive", () => c.got.slice(eventIndex(c, "revive")).find((m): m is Snapshot => m.t === "snapshot"));
    expect((await after(b.c)).me).toMatchObject({ al: 1, dn: 0, hl: 1 });
    expect((await after(a.c)).me.sc).toBeGreaterThanOrEqual(REVIVE_POINTS);
  },
  TIMEOUT,
);

test(
  "two clients (#73): both see a pickup on the floor, then a pickup event and the taker's effect bit when one walks over it",
  async () => {
    const a = await enter("Ada", "tabs");
    const b = await enter("Bob", "spaces");
    const ida = a.welcome.you;
    const room = srv.rooms.room(a.welcome.arena)!;
    const pa = room.state.players.find((p) => p.id === ida)!;
    const pb = room.state.players.find((p) => p.id === b.welcome.you)!;
    // Between ticks: no bugs, Bob well to Ada's left, and a shield 200 units to her right.
    room.state.bugs.length = 0;
    pa.budget = 0;
    pb.budget = 0;
    pa.invulnTicks = 400;
    pb.x = Math.max(20, pa.x - 300);
    pb.y = pa.y;
    const f = placePickup(room.state, pa.x + 200, pa.y, "shield");
    for (const c of [a.c, b.c]) {
      const seen = await c.waitFor("the pickup in a snapshot", () => c.got.find((m): m is Snapshot => m.t === "snapshot" && m.f.some((r) => r[0] === f.id)));
      const row = seen.f.find((r) => r[0] === f.id)!;
      expect(row[1]).toBe(PICKUP_IDS.indexOf("shield"));
      expect(row[2]).toBeCloseTo(f.x, 0);
    }
    // Ada walks right with real inputs until both see her take it.
    const taken = Promise.all([a.c, b.c].map((c) => c.waitFor("Ada's pickup event", () => eventIndex(c, "pickup") >= 0)));
    let done = false;
    void taken.finally(() => (done = true));
    let seq = 0;
    while (!done) {
      a.c.send(encodeInput({ seq: ++seq, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
      await Bun.sleep(50);
    }
    await taken;
    for (const c of [a.c, b.c]) {
      expect(c.got[eventIndex(c, "pickup")]).toEqual({ t: "event", kind: "pickup", id: ida, pickup: PICKUP_IDS.indexOf("shield") });
      // The next snapshot: the floor is empty, and Ada's row carries the shield's bit.
      const next = await c.waitFor("a snapshot after the pickup", () => c.got.slice(eventIndex(c, "pickup")).find((m): m is Snapshot => m.t === "snapshot"));
      expect(next.f).toEqual([]);
      expect(next.p.find((r) => r[0] === ida)![10]).toBe(1 << PICKUP_IDS.indexOf("shield"));
    }
    // Only the taker's own numbers carry the timer.
    const mine = await a.c.waitFor("Ada's timer", () => a.c.got.slice(eventIndex(a.c, "pickup")).find((m): m is Snapshot => m.t === "snapshot"));
    expect(mine.me.fx[PICKUP_IDS.indexOf("shield")]).toBeGreaterThan(0);
    const his = await b.c.waitFor("Bob's numbers", () => b.c.got.slice(eventIndex(b.c, "pickup")).find((m): m is Snapshot => m.t === "snapshot"));
    expect(his.me.fx).toEqual(PICKUP_IDS.map(() => 0));
  },
  TIMEOUT,
);
