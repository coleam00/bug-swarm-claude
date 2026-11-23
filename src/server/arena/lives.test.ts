import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { computeStats, findPlayer, openDb, playerBest, teamTotals, topTen, upsertPlayer } from "../db";
import { countsAsLife, createLifeSaver, writeLife } from "./lives";
import type { LifeRecord } from "./room";

const KEY = "a".repeat(32);
const life = (over: Partial<LifeRecord> = {}): LifeRecord => ({
  playerKey: KEY,
  name: "Ada",
  team: "tabs",
  touch: true,
  score: 420,
  kills: 30,
  seconds: 95.5,
  endedAtMs: Date.UTC(2026, 10, 28, 15, 0, 0),
  ...over,
});

let db: Database;
beforeEach(() => {
  db = openDb(":memory:");
});
afterEach(() => db.close());

describe("what counts as a life (#114)", () => {
  const ZERO_STATS = { players: 0, finishedRuns: 0, medianRunsPerPlayer: 0, touchShare: 0 };
  const saverNow = () => createLifeSaver(db, { defer: () => {} });

  test("0 points within the first 5 s is not a life; points, or 5 s, are", () => {
    // seconds = ticks * 50 ms: 99 ticks is 4.95 s, 100 ticks is 5 s.
    expect(countsAsLife(0, 4.95)).toBe(false);
    expect(countsAsLife(0, 0)).toBe(false);
    expect(countsAsLife(0, 5)).toBe(true);
    expect(countsAsLife(1, 0.05)).toBe(true);
  });

  test("the saver drops a 0-point life under 5 s: no stats, no player, no top 10 row, no team points", () => {
    const saver = saverNow();
    saver.save(life({ score: 0, kills: 0, seconds: 4.95 }));
    saver.save(life({ score: 0, kills: 0, seconds: 0 }));
    saver.flush();
    expect(computeStats(db)).toEqual(ZERO_STATS);
    expect(findPlayer(db, KEY)).toBeNull();
    expect(playerBest(db, KEY)).toBeNull();
    expect(topTen(db)).toEqual([]);
    expect(teamTotals(db)).toEqual({ tabs: 0, spaces: 0 });
  });

  test("a real short life with points counts", () => {
    const saver = saverNow();
    saver.save(life({ score: 10, kills: 1, seconds: 1.2 }));
    saver.flush();
    expect(computeStats(db)).toEqual({ players: 1, finishedRuns: 1, medianRunsPerPlayer: 1, touchShare: 100 });
    expect(topTen(db)).toEqual([{ name: "Ada", score: 10 }]);
    expect(teamTotals(db)).toEqual({ tabs: 10, spaces: 0 });
  });

  test("a 0-point life of 5 s or more is saved and counted, but not ranked", () => {
    const saver = saverNow();
    saver.save(life({ score: 0, kills: 0, seconds: 6 }));
    saver.flush();
    expect(computeStats(db).finishedRuns).toBe(1);
    expect(playerBest(db, KEY)).toBe(0);
    expect(topTen(db)).toEqual([]);
  });
});

describe("saving a life", () => {
  test("a saved life counts in the top 10, the player's best, team totals and the bet's stats", () => {
    writeLife(db, "run-1", life());
    writeLife(db, "run-2", life({ score: 100, touch: false }));
    expect(topTen(db)).toEqual([{ name: "Ada", score: 420 }]);
    expect(playerBest(db, KEY)).toBe(420);
    expect(teamTotals(db)).toEqual({ tabs: 520, spaces: 0 });
    expect(computeStats(db)).toEqual({ players: 1, finishedRuns: 2, medianRunsPerPlayer: 2, touchShare: 50 });
  });

  test("the team stored for a player wins over the one in their hello", () => {
    upsertPlayer(db, KEY, "Ada", "spaces", new Date(0));
    writeLife(db, "run-1", life({ team: "tabs" }));
    expect(findPlayer(db, KEY)?.team).toBe("spaces");
    expect(teamTotals(db)).toEqual({ tabs: 0, spaces: 420 });
  });

  test("the saver writes off the caller's turn, and a failed write is logged with its run id, never thrown", () => {
    const deferred: (() => void)[] = [];
    const logged: string[] = [];
    let n = 0;
    const saver = createLifeSaver(db, {
      defer: (fn) => void deferred.push(fn),
      log: (line) => void logged.push(line),
      newId: () => `run-${++n}`,
    });
    saver.save(life());
    saver.save(life({ score: 5 }));
    expect(topTen(db)).toEqual([]);
    expect(deferred.length).toBe(1);
    deferred[0]!();
    expect(playerBest(db, KEY)).toBe(420);
    expect(computeStats(db).finishedRuns).toBe(2);
    // A run id already used makes the write throw inside its transaction.
    n = 0;
    saver.save(life({ score: 999 }));
    expect(() => saver.flush()).not.toThrow();
    expect(logged).toEqual(["arena life run-1: save failed"]);
    expect(playerBest(db, KEY)).toBe(420);
  });
});
