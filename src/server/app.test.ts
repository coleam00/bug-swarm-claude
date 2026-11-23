import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { TOP_CACHE_MS, createApp } from "./app";
import type { LiveArenas } from "./arena/rooms";
import { findPlayer, hideName, openDb, playerBest, recordRunEnded, recordRunStarted, upsertPlayer } from "./db";
import { writeLife } from "./arena/lives";
import { ROBOT_RIM } from "../web/game/look";
import { TEAMS, type Team } from "./rules";

const [TABS, SPACES] = TEAMS;

let dir: string;
let db: Database;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "app-test-"));
  db = openDb(join(dir, "app.db"));
  clock = Date.parse("2026-11-28T15:00:00.000Z");
});

afterEach(() => {
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

type App = ReturnType<typeof createApp>;
const app = (): App => createApp(db, { now: () => clock });

// Runs are written as the arena saves a life (arena/lives.ts writeLife: the stored team wins, the
// name is upserted), split into its start and end so a test can leave one unfinished.
let nextRun = 0;
const started = new Map<string, { playerId: string; team: Team | null }>();

/** Starts a run, with a team unless `team` is null (a player from before teams). */
function startRun(_a: App, playerId = "player-0001", name = "Robo", team: Team | null = TABS): string {
  const runId = `run-${nextRun++}`;
  const at = new Date(clock);
  const stored = findPlayer(db, playerId)?.team ?? team;
  upsertPlayer(db, playerId, name, stored, at);
  recordRunStarted(db, runId, playerId, at, stored);
  started.set(runId, { playerId, team: stored });
  return runId;
}

/** Ends a run started with startRun, at the clock. */
function endRun(runId: string, score: number, squashes = 0, seconds = 0, touch = false): void {
  const start = started.get(runId)!;
  recordRunEnded(db, { runId, playerId: start.playerId, score, squashes, seconds, touch, upgrades: [], team: start.team }, new Date(clock));
}

test("health answers ok", async () => {
  const res = await app().request("/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});

describe("top 10 and best", () => {
  async function play(a: App, playerId: string, name: string, score: number) {
    const runId = startRun(a, playerId, name);
    clock += 10_000;
    endRun(runId, score, Math.floor(score / 10), 10);
  }

  async function top(a: App) {
    return ((await (await a.request("/api/top")).json()) as { top: { name: string; score: number }[] }).top;
  }

  test("best score per player, one row each, highest first, at most 10", async () => {
    const a = app();
    for (let i = 0; i < 12; i++) await play(a, `player-${1000 + i}`, `P${i}`, 10 * i);
    await play(a, "player-1000", "P0", 500);
    await play(a, "player-1000", "P0", 105); // a second row for P0 would push P3 off
    expect(await top(a)).toEqual([
      { name: "P0", score: 500 },
      { name: "P11", score: 110 },
      { name: "P10", score: 100 },
      { name: "P9", score: 90 },
      { name: "P8", score: 80 },
      { name: "P7", score: 70 },
      { name: "P6", score: 60 },
      { name: "P5", score: 50 },
      { name: "P4", score: 40 },
      { name: "P3", score: 30 },
    ]);
  });

  test("a hidden name is left out, whatever its case", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50);
    await play(a, "player-0002", "Good", 40);
    hideName(db, "  bad  NAME ", new Date(clock));
    expect(await top(a)).toEqual([{ name: "Good", score: 40 }]);
  });

  test("is cached for 1 second", async () => {
    const a = app();
    await play(a, "player-0001", "First", 30);
    expect(await top(a)).toEqual([{ name: "First", score: 30 }]);
    const runId = startRun(a, "player-0002", "Second");
    clock += 500;
    endRun(runId, 5, 0, 0);
    expect(await top(a)).toEqual([{ name: "First", score: 30 }]);
    clock += 500;
    expect(await top(a)).toEqual([
      { name: "First", score: 30 },
      { name: "Second", score: 5 },
    ]);
  });

  type Me = { rank: number | null; ranked: number; next: { rank: number; points: number } | null; row: number | null; held?: { name: string; rank: number; score: number } };
  async function standing(a: App, playerId: string) {
    const res = await a.request(`/api/top?player=${playerId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { top: { name: string; score: number }[]; me: Me };
  }

  test("?player= adds where that player stands: rank, how many are ranked, the points to the next rank, their row", async () => {
    const a = app();
    await play(a, "player-0001", "Ada", 100);
    await play(a, "player-0002", "Bob", 50);
    await play(a, "player-0003", "Cy", 30);
    clock += TOP_CACHE_MS;
    const { top, me } = await standing(a, "player-0003");
    expect(top.map((r) => r.name)).toEqual(["Ada", "Bob", "Cy"]);
    expect(me).toEqual({ rank: 3, ranked: 3, next: { rank: 2, points: 21 }, row: 2 });
    expect((await standing(a, "player-0001")).me).toEqual({ rank: 1, ranked: 3, next: null, row: 0 });
  });

  test("ties: distinct ranks, the earlier first finisher ahead, and 1 point passes a tie", async () => {
    const a = app();
    await play(a, "player-000b", "Bee", 20); // B's first finish is earlier than A's...
    await play(a, "player-000a", "Aye", 50);
    await play(a, "player-000b", "Bee", 50); // ...so B is ahead at 50 each
    clock += TOP_CACHE_MS;
    expect((await standing(a, "player-000b")).me).toEqual({ rank: 1, ranked: 2, next: null, row: 0 });
    expect((await standing(a, "player-000a")).me).toEqual({ rank: 2, ranked: 2, next: { rank: 1, points: 1 }, row: 1 });
  });

  test("ties inside the same millisecond still get distinct ranks, in the rows' order", async () => {
    const a = app();
    const ids = ["player-0003", "player-0001", "player-0002"];
    const runs = [];
    for (const id of ids) runs.push(startRun(a, id, id.slice(-4)));
    clock += 10_000;
    for (const r of runs) endRun(r, 40, 4, 10);
    clock += TOP_CACHE_MS;
    for (const id of ids) {
      const { me } = await standing(a, id);
      expect(me.rank).toBe(me.row! + 1);
    }
    expect((await standing(a, "player-0001")).me.rank).toBe(1);
  });

  test("a name takes one row, at its best life, and only that life's player is ranked on it (#106)", async () => {
    const a = app();
    const spellings = ["Churn", "churn", "CHURN"];
    for (let i = 0; i < 10; i++) await play(a, `player-c${String(i).padStart(3, "0")}`, spellings[i % 3]!, 100 + i * 10);
    await play(a, "player-0ada", "Ada", 150);
    await play(a, "player-0bob", "Bob", 10);
    clock += TOP_CACHE_MS;
    // The holder of the Churn row is ranked on it. Another Churn whose own best (130) is below
    // it gets no rank or highlighted row, only who holds the name (owner ruling).
    expect((await standing(a, "player-c009")).me).toEqual({ rank: 1, ranked: 3, next: null, row: 0 });
    expect((await standing(a, "player-c003")).me).toEqual({ rank: null, ranked: 3, next: null, row: null, held: { name: "Churn", rank: 1, score: 190 } });
    expect((await standing(a, "player-0ada")).me).toEqual({ rank: 2, ranked: 3, next: { rank: 1, points: 41 }, row: 1 });
  });

  test("a hidden name has no rank and counts for nobody, whatever its case, from the next cache turn on", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 100);
    await play(a, "player-0002", "Good", 50);
    clock += TOP_CACHE_MS;
    expect((await standing(a, "player-0002")).me).toEqual({ rank: 2, ranked: 2, next: { rank: 1, points: 51 }, row: 1 });
    hideName(db, "  bad  NAME ", new Date(clock));
    // Inside the cached second, the hide hasn't reached the ranking yet: the old standing stays.
    expect((await standing(a, "player-0001")).me.rank).toBe(1);
    clock += TOP_CACHE_MS;
    expect((await standing(a, "player-0001")).me).toEqual({ rank: null, ranked: 1, next: null, row: null });
    expect((await standing(a, "player-0002")).me).toEqual({ rank: 1, ranked: 1, next: null, row: 0 });
  });

  test("a stored name the word lists now refuse has no rank and doesn't count toward anyone's", async () => {
    const a = app();
    await play(a, "player-0001", "Old Name", 100);
    await play(a, "player-0002", "Good", 50);
    db.query("UPDATE players SET name = ? WHERE id = ?").run("fuuuck", "player-0001"); // stored before the list grew
    clock += TOP_CACHE_MS;
    expect((await standing(a, "player-0001")).me).toEqual({ rank: null, ranked: 1, next: null, row: null });
    expect((await standing(a, "player-0002")).me).toEqual({ rank: 1, ranked: 1, next: null, row: 0 });
  });

  test("no finished run, or an id the server never saw: no rank, the ranked count still given", async () => {
    const a = app();
    await play(a, "player-0001", "Ada", 100);
    startRun(a, "player-0002", "Bob"); // started, never finished
    clock += TOP_CACHE_MS;
    const none = { rank: null, ranked: 1, next: null, row: null };
    expect((await standing(a, "player-0002")).me).toEqual(none);
    expect((await standing(a, "player-9999")).me).toEqual(none);
  });

  test("a run that just finished ranks at once, and that player's own row is in their top 10 at once", async () => {
    const a = app();
    await play(a, "player-0001", "Ada", 100);
    await play(a, "player-0002", "Bob", 50);
    const runId = startRun(a, "player-0003", "Cy");
    clock += 10_000;
    expect((await standing(a, "player-0003")).me).toEqual({ rank: null, ranked: 2, next: null, row: null });
    // Same instant: inside the window the read above filled.
    endRun(runId, 60, 6, 10);
    const fresh = await standing(a, "player-0003");
    expect(fresh.top.map((r) => r.name)).toEqual(["Ada", "Cy", "Bob"]);
    expect(fresh.me).toEqual({ rank: 2, ranked: 3, next: { rank: 1, points: 41 }, row: 1 });
    // Everyone else's top 10 follows the snapshot: Cy shows there from the next cache turn.
    expect((await top(a)).map((r) => r.name)).toEqual(["Ada", "Bob"]);
    clock += TOP_CACHE_MS;
    const later = await standing(a, "player-0003");
    expect(later.top.map((r) => r.name)).toEqual(["Ada", "Cy", "Bob"]);
    expect(later.me).toEqual({ rank: 2, ranked: 3, next: { rank: 1, points: 41 }, row: 1 });
  });

  /** Seeds `n` players at scores 100, 101, ... (names Seed100, ...) and fills the cache. */
  async function seeded(n: number) {
    const a = app();
    for (let i = 0; i < n; i++) await play(a, `player-seed${100 + i}`, `Seed${100 + i}`, 100 + i);
    clock += TOP_CACHE_MS;
    return a;
  }

  // From here on in each test the clock stands still, so the snapshot is the one read before the save.
  const life = (playerKey: string, name: string, score: number) =>
    writeLife(db, `run-${nextRun++}`, { playerKey, name, team: TABS, touch: false, score, kills: 1, seconds: 30, endedAtMs: clock });

  test("a life that just ended is on that player's top 10 at once, row marked, with no new ranking query (#105)", async () => {
    const a = await seeded(10);
    await standing(a, "player-rec01"); // the snapshot, read before the life ends
    const queries = spyOn(db, "query");
    life("player-rec01", "Rec", 99999);
    const { top: rows, me } = await standing(a, "player-rec01");
    expect(rows[0]).toEqual({ name: "Rec", score: 99999 });
    expect(rows).toHaveLength(10);
    expect(rows.some((r) => r.name === "Seed100")).toBe(false);
    expect(me).toEqual({ rank: 1, ranked: 11, next: null, row: 0 });
    expect(queries.mock.calls.every(([sql]) => !String(sql).includes("GROUP BY"))).toBe(true);
    queries.mockRestore();
  });

  test("a player already on the top 10 moves up: one row for them, the rows between shift down", async () => {
    const a = await seeded(9);
    await play(a, "player-mover1", "Mover", 101); // 8th of 10
    clock += TOP_CACHE_MS;
    await standing(a, "player-mover1");
    life("player-mover1", "Mover", 106);
    const { top: rows, me } = await standing(a, "player-mover1");
    expect(rows.map((r) => r.score)).toEqual([108, 107, 106, 106, 105, 104, 103, 102, 101, 100]);
    expect(rows.filter((r) => r.name === "Mover")).toEqual([{ name: "Mover", score: 106 }]);
    // Seed106 finished first, so the tie goes to them, as the ranking orders it.
    expect(rows[2]!.name).toBe("Seed106");
    expect(me.row).toBe(3);
    expect(me.rank).toBe(4);
  });

  test("a newcomer tying the 10th row sits after it, as the ranking orders ties", async () => {
    const a = await seeded(10);
    await standing(a, "player-tie001");
    life("player-tie001", "Tie", 100);
    const { top: rows, me } = await standing(a, "player-tie001");
    expect(rows.at(-1)).toEqual({ name: "Seed100", score: 100 });
    expect(me).toMatchObject({ rank: 11, row: null });
    life("player-tie002", "Tie Two", 101);
    const two = await standing(a, "player-tie002");
    expect(two.top.slice(-2)).toEqual([{ name: "Seed101", score: 101 }, { name: "Tie Two", score: 101 }]);
    expect(two.me).toMatchObject({ rank: 10, row: 9 });
  });

  test("a hidden name's fresh best is not put on any top 10", async () => {
    const a = await seeded(10);
    hideName(db, "Hidden", new Date(clock));
    clock += TOP_CACHE_MS;
    const before = await standing(a, "player-hide01");
    life("player-hide01", "Hidden", 99999);
    const after = await standing(a, "player-hide01");
    expect(after.top).toEqual(before.top);
    expect(after.me).toEqual({ rank: null, ranked: 10, next: null, row: null });
  });

  test("a missing or malformed ?player= gives exactly { top }; no player id is ever sent back", async () => {
    const a = app();
    await play(a, "player-0001", "Ada", 100);
    clock += TOP_CACHE_MS;
    for (const q of ["", "?player=bad!", "?player=short", "?player="]) {
      expect(await (await a.request(`/api/top${q}`)).json()).toEqual({ top: [{ name: "Ada", score: 100 }] });
    }
    expect(await (await a.request("/api/top?player=player-0001")).text()).not.toContain("player-0001");
  });

  test("500 ranked players: every rank read inside the second comes from one cached ranking", async () => {
    const a = app();
    db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const id = `player-${String(i).padStart(4, "0")}`;
        upsertPlayer(db, id, `Player ${i}`, TABS, new Date(clock)); // not "P155", which reads "piss"
        recordRunEnded(db, { runId: `run-${i}`, playerId: id, score: i + 1, squashes: 0, seconds: 0, touch: false, upgrades: [], team: TABS }, new Date(clock + i));
      }
    })();
    expect((await standing(a, "player-0000")).me).toMatchObject({ rank: 500, ranked: 500, next: { rank: 499, points: 2 } });
    const queries = spyOn(db, "query");
    for (let i = 0; i < 50; i++) await standing(a, `player-${String(i * 10).padStart(4, "0")}`);
    // Per read: the player's row and their best, both by key. The ranking isn't read again.
    expect(queries.mock.calls.every(([sql]) => !String(sql).includes("GROUP BY"))).toBe(true);
    clock += TOP_CACHE_MS;
    await standing(a, "player-0000");
    expect(queries.mock.calls.some(([sql]) => String(sql).includes("GROUP BY"))).toBe(true);
    queries.mockRestore();
  });

  test("a player's best", async () => {
    const a = app();
    const best = async (id: string) => (await (await a.request(`/api/players/${id}/best`)).json()) as { best: number | null };
    expect(await best("player-0001")).toEqual({ best: null });
    await play(a, "player-0001", "Robo", 40);
    await play(a, "player-0001", "Robo", 20);
    expect(await best("player-0001")).toEqual({ best: 40 });
  });
});

describe("team totals", () => {
  async function play(a: App, playerId: string, name: string, score: number, team: Team | null = TABS) {
    const runId = startRun(a, playerId, name, team);
    clock += 10_000;
    endRun(runId, score, Math.floor(score / 10), 10);
  }

  async function teams(a: App) {
    const res = await a.request("/api/teams");
    expect(res.status).toBe(200);
    return ((await res.json()) as { teams: Record<Team, number> }).teams;
  }

  test("sum every finished run's score into its team; an abandoned run adds nothing", async () => {
    const a = app();
    await play(a, "player-0001", "Ann", 50, TABS);
    await play(a, "player-0001", "Ann", 20, TABS); // every run counts, not just the best
    await play(a, "player-0002", "Bob", 30, SPACES);
    startRun(a, "player-0003", "Cat", SPACES); // abandoned
    expect(await teams(a)).toEqual({ tabs: 70, spaces: 30 });
  });

  test("a run from before the player had a team counts for nobody, even after they pick one", async () => {
    const a = app();
    upsertPlayer(db, "player-0001", "Old Timer", null, new Date(clock));
    await play(a, "player-0001", "Old Timer", 40, null);
    expect(await teams(a)).toEqual({ tabs: 0, spaces: 0 });
    await play(a, "player-0001", "Old Timer", 25, SPACES);
    expect(await teams(a)).toEqual({ tabs: 0, spaces: 25 });
    expect(db.query("SELECT team FROM players WHERE id = ?").get("player-0001")).toEqual({ team: SPACES });
  });

  test("a hidden name's runs leave the totals once the 1 s cache turns over", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50, TABS);
    await play(a, "player-0002", "Good", 40, TABS);
    expect(await teams(a)).toEqual({ tabs: 90, spaces: 0 }); // primes the cache
    hideName(db, "  bad  NAME ", new Date(clock));
    clock += 999;
    expect(await teams(a)).toEqual({ tabs: 90, spaces: 0 });
    clock += 1; // 1 s cache + the game-over screen's 4 s poll: gone from every screen within 5 s
    expect(await teams(a)).toEqual({ tabs: 40, spaces: 0 });
  });
});

describe("the stream board's read", () => {
  async function play(a: App, playerId: string, name: string, score: number, team: Team) {
    const runId = startRun(a, playerId, name, team);
    clock += 10_000;
    endRun(runId, score, Math.floor(score / 10), 1);
  }

  type Board = {
    top: { name: string; score: number }[];
    teams: Record<Team, number>;
    playing: number;
    arenas: { id: number; players: number; wave: number; queen: number | null }[];
  };
  async function board(a: App): Promise<Board> {
    const res = await a.request("/api/board");
    expect(res.status).toBe(200);
    return (await res.json()) as Board;
  }

  test("returns the top 10 and both team totals together", async () => {
    const a = app();
    await play(a, "player-0001", "Ann", 50, TABS);
    await play(a, "player-0002", "Bob", 30, SPACES);
    await play(a, "player-0001", "Ann", 20, TABS);
    expect(await board(a)).toEqual({
      top: [
        { name: "Ann", score: 50 },
        { name: "Bob", score: 30 },
      ],
      teams: { tabs: 70, spaces: 30 },
      playing: 0,
      arenas: [],
    });
  });

  test("a hidden name is in neither the top 10 nor the team totals", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50, TABS);
    await play(a, "player-0002", "Good", 40, SPACES);
    hideName(db, "bad name", new Date(clock));
    expect(await board(a)).toEqual({ top: [{ name: "Good", score: 40 }], teams: { tabs: 0, spaces: 40 }, playing: 0, arenas: [] });
  });

  test("both halves are cached for 1 second, like the routes it combines", async () => {
    const a = app();
    await play(a, "player-0001", "Bad Name", 50, TABS);
    await play(a, "player-0002", "Good", 40, SPACES);
    const before = await board(a); // primes both caches
    hideName(db, "bad name", new Date(clock)); // moves the top 10 and the Tabs total alike
    clock += 999;
    expect(await board(a)).toEqual(before);
    clock += 1;
    expect(await board(a)).toEqual({ top: [{ name: "Good", score: 40 }], teams: { tabs: 0, spaces: 40 }, playing: 0, arenas: [] });
  });

  test("the people playing and the open arenas come from the rooms on every read, never cached (#74)", async () => {
    let live: LiveArenas = { playing: 1, arenas: [{ id: 1, players: 1, wave: 1, queen: null }] };
    const a = createApp(db, { now: () => clock, live: () => live });
    await play(a, "player-0001", "Ann", 50, TABS);
    const before = await board(a); // primes both caches
    expect(before).toEqual({ top: [{ name: "Ann", score: 50 }], teams: { tabs: 50, spaces: 0 }, ...live });
    // A hive queen at 64% in arena 1 (#102): her health travels as the rooms report it.
    live = { playing: 21, arenas: [{ id: 1, players: 20, wave: 5, queen: 64 }, { id: 2, players: 1, wave: 1, queen: null }] };
    endRun(startRun(a, "player-0002", "Bob", SPACES), 30); // at the same instant: inside the 1 s window
    expect(await board(a)).toEqual({ top: before.top, teams: before.teams, ...live });
  });
});

test("reopening the same database file keeps its data", async () => {
  const runId = startRun(app());
  db.close();
  db = openDb(join(dir, "app.db"));
  clock += 5000;
  endRun(runId, 5, 0, 5);
  expect(playerBest(db, "player-0001")).toBe(5);
});

describe("icons and link preview", () => {
  /** Width and height from a PNG's IHDR. */
  const pngSize = (b: Uint8Array) => {
    const v = new DataView(b.buffer, b.byteOffset);
    return [v.getUint32(16), v.getUint32(20)];
  };
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  test.each([
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/apple-touch-icon.png", "image/png"],
    ["/og.png", "image/png"],
  ])("%s answers 200 %s, cached for a day", async (path, type) => {
    const res = await app().request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(type);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    // The first /og.png request draws the 1200x630 preview (0.4 s alone, near 5 s under CPU load);
    // it is one heavy render, not a timing test, so it gets room past the 5 s default (#41).
  }, 30_000);

  test("the favicon is an SVG of the robot, in its rim colour", async () => {
    const svg = await (await app().request("/favicon.svg")).text();
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(ROBOT_RIM);
  });

  test("favicon.ico wraps a 48 px PNG", async () => {
    const ico = new Uint8Array(await (await app().request("/favicon.ico")).arrayBuffer());
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect([...ico.subarray(22, 30)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(ico.subarray(22))).toEqual([48, 48]);
  });

  test("the apple-touch icon is a 180 px PNG and the preview a 1200x630 PNG", async () => {
    const icon = new Uint8Array(await (await app().request("/apple-touch-icon.png")).arrayBuffer());
    expect([...icon.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(icon)).toEqual([180, 180]);
    const og = new Uint8Array(await (await app().request("/og.png")).arrayBuffer());
    expect([...og.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(og)).toEqual([1200, 630]);
  });
});
