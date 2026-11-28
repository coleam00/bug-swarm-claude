import { describe, expect, test } from "bun:test";
import { BUG_KINDS, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createRng } from "../src/shared/arena/rng";
import { stepPlayer } from "../src/shared/arena/sim";
import { TEAMS } from "../src/server/rules";
import type { Snapshot, SnapshotBug } from "../src/shared/arena/protocol";
import { createObservationTracker } from "./bots-lib";
import {
  AIM_TURN,
  KBPS_PER_PLAYER_BUDGET,
  TICK_P95_BUDGET_MS,
  WALL_AVOID,
  botName,
  botTeam,
  budgetVerdict,
  refusalHint,
  countBytes,
  exitCode,
  createTally,
  firstHalfKbps,
  createWander,
  formatSummary,
  parseBotsArgs,
  rateStats,
  secondHalfKbps,
  stepWander,
  wsUrl,
} from "./bots-lib";

describe("parseBotsArgs", () => {
  test("defaults to 18 aimer bots for 60 seconds, and strips a trailing slash", () => {
    expect(parseBotsArgs(["--url", "http://127.0.0.1:3000/"])).toEqual({ url: "http://127.0.0.1:3000", count: 18, seconds: 60, policy: "aimer", watchers: 0 });
  });

  test("takes both flag forms and skips a bare --", () => {
    expect(parseBotsArgs(["--", "--url=https://x.test", "--count", "5", "--seconds=10", "--policy", "wander"])).toEqual({
      url: "https://x.test",
      count: 5,
      seconds: 10,
      policy: "wander",
      watchers: 0,
    });
    expect(parseBotsArgs(["--url", "http://x", "--policy=mover"]).policy).toBe("mover");
  });

  test("refuses a missing url, unknown flags and anything but positive whole numbers", () => {
    for (const argv of [[], ["--count", "3"], ["--url", "ftp://x"], ["--url", "nope"], ["--url", "http://x", "--count", "0"], ["--url", "http://x", "--seconds", "1.5"], ["--url", "http://x", "--count", "-2"], ["--url", "http://x", "--policy", "sniper"], ["--url", "http://x", "--policy", "idle"], ["--url"]]) {
      expect(() => parseBotsArgs(argv)).toThrow();
    }
  });
});

test("names, teams and the socket URL", () => {
  expect([botName(1), botName(9), botName(18), botName(100)]).toEqual(["bots-01", "bots-09", "bots-18", "bots-100"]);
  expect([botTeam(1), botTeam(2), botTeam(3)]).toEqual([TEAMS[0], TEAMS[1], TEAMS[0]]);
  expect(wsUrl("http://127.0.0.1:3000")).toBe("ws://127.0.0.1:3000/ws");
  expect(wsUrl("https://bugs.example")).toBe("wss://bugs.example/ws");
});

describe("wandering", () => {
  test("a wandering bot keeps moving, changes heading every 1 to 3 s, and stays off the walls", () => {
    const rng = createRng(5);
    const w = createWander();
    const body = { x: WORLD_W / 2, y: WORLD_H / 2, vx: 0, vy: 0 };
    const out = { mx: 0, my: 0, aim: 0 };
    const headings = new Set<number>();
    let lastAim = 0;
    let nearWallSteps = 0;
    for (let i = 0; i < 20 * 120; i++) {
      stepWander(w, rng, body.x, body.y, out);
      expect(Math.hypot(out.mx, out.my)).toBeCloseTo(1, 9);
      let turn = Math.abs(out.aim - lastAim);
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      expect(turn).toBeLessThanOrEqual(AIM_TURN + 1e-9);
      lastAim = out.aim;
      headings.add(w.heading);
      stepPlayer(body, out.mx, out.my);
      if (body.x < 14.5 || body.y < 14.5 || body.x > WORLD_W - 14.5 || body.y > WORLD_H - 14.5) nearWallSteps++;
    }
    // 2 minutes: 40 to 120 random headings, plus turns away from walls.
    expect(headings.size).toBeGreaterThanOrEqual(40);
    expect(nearWallSteps).toBe(0);
  });

  test("near a wall it heads for the centre", () => {
    const w = createWander();
    const out = { mx: 0, my: 0, aim: 0 };
    stepWander(w, createRng(1), WALL_AVOID - 1, WORLD_H / 2, out);
    expect(out.mx).toBeCloseTo(1, 6);
    stepWander(w, createRng(1), WORLD_W / 2, WORLD_H - 10, out);
    expect(out.my).toBeCloseTo(-1, 6);
  });

  test("the same seed wanders the same way", () => {
    const run = () => {
      const rng = createRng(77);
      const w = createWander();
      const out = { mx: 0, my: 0, aim: 0 };
      const seen: number[] = [];
      for (let i = 0; i < 200; i++) {
        stepWander(w, rng, 1200, 1200, out);
        seen.push(out.mx, out.aim);
      }
      return seen;
    };
    expect(run()).toEqual(run());
  });
});

test("the summary counts joins, arenas, messages per second, errors and the tick", () => {
  const tally = createTally();
  tally.joins = 18;
  tally.arenas.add(1);
  tally.messages = 21_600;
  tally.errors.push("close 1006", "close 1006", "error name");
  // The values, not the wording: messages per second overall and per bot, errors grouped by kind.
  tally.lives.push(300, 40, 120);
  const text = formatSummary({ url: "http://127.0.0.1:3000", count: 18, seconds: 60, policy: "aimer", watchers: 0 }, tally, 60, { p50: 0.12, p95: 0.4 }).join(" ");
  for (const part of ["18 of 18", "360.0/s", "20.0/s", "errors: 3", "close 1006 x2", "error name x1", "0.12", "0.40", "lives ended: 3", "median score 120", "aimer"]) {
    expect(text).toContain(part);
  }
  expect(formatSummary({ url: "u", count: 1, seconds: 1, policy: "wander", watchers: 0 }, createTally(), 1, null).join(" ")).toContain("unavailable");
});

test("a policy bot sees itself from its row and its numbers, and each bug's velocity from its last two positions", () => {
  const t = createObservationTracker();
  const snap = (tick: number, b: [number, number, number, number][], al: 0 | 1 = 1): Snapshot => ({
    t: "snapshot",
    tick,
    ack: 0,
    p: [
      [1, 100, 100, 0, 0, 0, 1, 0, 0, 0, 0],
      [2, 500, 600, 30, -40, 1.5, 1, 0, 0, 0, 0],
    ],
    b,
    q: [],
    g: [],
    s: [],
    e: [],
    k: [],
    d: [],
    f: tick === 10 ? [[1, 0, 700, 710, 200]] : [],
    w: 1,
    me: { sc: 0, ki: 0, st: 0, mu: 1, he: 0.42, lk: 1, hl: 2, al, dk: 0, dc: 0, dn: 0, fx: [0, 0], x: 0, y: 0, vx: 0, vy: 0 },
  });
  t.update(snap(10, [[7, 0, 300, 300]]), 2);
  expect(t.obs.self).toEqual({ x: 500, y: 600, vx: 30, vy: -40, aim: 1.5, alive: true, heat: 0.42, locked: true, dashReady: true });
  expect(t.obs.bugCount).toBe(1);
  expect(t.obs.bugs[0]).toEqual({ x: 300, y: 300, vx: 0, vy: 0, fx: 0, fy: 0 });
  // The floor's pickups (#73), so `bun run bots` policies see what `bun run skill`'s see.
  expect(t.obs.pickupCount).toBe(1);
  expect(t.obs.pickups[0]).toEqual({ x: 700, y: 710 });
  t.update(snap(11, [[9, 0, 50, 50], [7, 0, 308, 294]]), 2);
  expect(t.obs.bugs[1]!.vx).toBeCloseTo(160, 6);
  expect(t.obs.bugs[1]!.vy).toBeCloseTo(-120, 6);
  expect(t.obs.bugs[0]).toEqual({ x: 50, y: 50, vx: 0, vy: 0, fx: 0, fy: 0 });
  expect(t.obs.pickupCount).toBe(0);
  // A snapshot skipped: the gap counts.
  t.update(snap(13, [[7, 0, 324, 282]], 0), 2);
  expect(t.obs.bugCount).toBe(1);
  expect(t.obs.bugs[0]!.vx).toBeCloseTo(160, 6);
  expect(t.obs.self.alive).toBe(false);
});

test("a policy bot sees a beetle's shell facing from its row's tail, and no facing on any other bug (#80)", () => {
  const t = createObservationTracker();
  const beetle = BUG_KINDS.indexOf("beetle");
  const dasher = BUG_KINDS.indexOf("dasher");
  const snap = (b: SnapshotBug[]): Snapshot => ({
    t: "snapshot",
    tick: 5,
    ack: 0,
    p: [[2, 500, 600, 0, 0, 0, 1, 0, 0, 0, 0]],
    b,
    s: [],
    e: [],
    k: [],
    d: [],
    f: [],
    q: [],
    g: [],
    w: 4,
    me: { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 1, dk: 0, dc: 0, dn: 0, fx: [0, 0], x: 0, y: 0, vx: 0, vy: 0 },
  });
  t.update(snap([[1, beetle, 300, 300, 1, Math.PI / 2, 0], [2, dasher, 100, 100, 1, 0.5, 3]]), 2);
  expect(t.obs.bugs[0]!.fx).toBeCloseTo(0, 9);
  expect(t.obs.bugs[0]!.fy).toBeCloseTo(1, 9);
  // A dasher's tail is its lunge line, not a shell: it is seen with no facing.
  expect([t.obs.bugs[1]!.fx, t.obs.bugs[1]!.fy]).toEqual([0, 0]);
  // The same slots reused by bugs with no shell: no facing left over from the beetle.
  t.update(snap([[3, 0, 10, 10], [1, beetle, 300, 300]]), 2);
  expect([t.obs.bugs[0]!.fx, t.obs.bugs[0]!.fy]).toEqual([0, 0]);
  expect([t.obs.bugs[1]!.fx, t.obs.bugs[1]!.fy]).toEqual([0, 0]);
});

test("--watchers opens watch sockets; --count 0 is allowed only with watchers (an empty server's demo arena)", () => {
  expect(parseBotsArgs(["--url", "http://x", "--count", "0", "--watchers", "10"])).toMatchObject({ count: 0, watchers: 10 });
  expect(parseBotsArgs(["--url", "http://x", "--watchers=3"])).toMatchObject({ count: 18, watchers: 3 });
  expect(() => parseBotsArgs(["--url", "http://x", "--count", "0"])).toThrow();
  expect(() => parseBotsArgs(["--url", "http://x", "--watchers", "-1"])).toThrow();
});

test("the summary gives each watcher's second-half KB/s, mean, p95 and max, and a budget line for them (#119)", () => {
  const tally = createTally();
  tally.watching = 2;
  tally.watcherKbps.push(65, 25);
  const args = { url: "u", count: 0, seconds: 10, policy: "aimer" as const, watchers: 2 };
  const text = formatSummary(args, tally, 10, { p50: 1, p95: 2 }).join("\n");
  expect(text).toContain("watchers: 2 of 2 watching, second half, payload: mean 45.0 KB/s, p95 65.0 KB/s, max 65.0 KB/s");
  expect(text).toContain("budget: at most 40 KB/s per watcher: MISS (max 65.0 KB/s)");
  expect(text).toContain("verdict: MISS (a watcher received 65.0 KB/s, over 40 KB/s)");
  tally.watcherKbps.splice(0, 2, 30, 25);
  expect(formatSummary(args, tally, 10, { p50: 1, p95: 2 }).join("\n")).toContain("budget: at most 40 KB/s per watcher: pass");
  // Watchers refused (a server without BUG_SWARM_ALLOW_LOAD=1): the line says so, not a bandwidth miss.
  const refused = formatSummary({ ...args, watchers: 300 }, { ...tally, watching: 6, watcherKbps: [8, 8] }, 10, { p50: 1, p95: 2 }).join("\n");
  expect(refused).toContain("budget: at most 40 KB/s per watcher: MISS (only 6 of 300 watching: the rest were refused, see the errors)");
  const none = formatSummary({ ...args, count: 1, watchers: 0 }, tally, 10, null).join(" ");
  expect(none).not.toContain("watchers:");
  expect(none).not.toContain("per watcher");
});

test("a refusal from the per-address limits says, once, to start the server with BUG_SWARM_ALLOW_LOAD=1 (#104, #119)", () => {
  expect(refusalHint("limit")).toContain("BUG_SWARM_ALLOW_LOAD=1");
  expect(refusalHint("full")).toContain("per-address watcher limit (6)");
  expect(refusalHint("full")).toContain("BUG_SWARM_ALLOW_LOAD=1");
  expect(refusalHint("name")).toBeNull();
});

describe("the budget gate (#89)", () => {
  const pass = { errors: 0, joins: 200, count: 200, tick: { p50: 1, p95: 2 }, kbps: rateStats([30, 35, 39.9])!, watchers: 0, watching: 0, watcherKbps: null };

  test("a bot's KB/s is its payload over the run's second half, or its part of it when it was welcomed late", () => {
    expect(secondHalfKbps({ first: 999_999, second: 1_800_000, welcomedAt: 0 }, 60_000, 120_000)).toBe(30);
    expect(secondHalfKbps({ first: 0, second: 900_000, welcomedAt: 90_000 }, 60_000, 120_000)).toBe(30);
    expect(secondHalfKbps({ first: 0, second: 0, welcomedAt: null }, 60_000, 120_000)).toBeNull();
    expect(secondHalfKbps({ first: 0, second: 10, welcomedAt: 119_500 }, 60_000, 120_000)).toBeNull();
    // The first half, printed only: from the welcome to the middle.
    expect(firstHalfKbps({ first: 500_000, second: 0, welcomedAt: 10_000 }, 60_000)).toBe(10);
    expect(firstHalfKbps({ first: 0, second: 0, welcomedAt: null }, 60_000)).toBeNull();
  });

  test("a message counts nowhere before the welcome, in the first half before the middle, in the gated second half from it", () => {
    const b = { first: 0, second: 0, welcomedAt: null as number | null };
    countBytes(b, 100, 1000, 60_000);
    expect(b).toEqual({ first: 0, second: 0, welcomedAt: null });
    b.welcomedAt = 2000;
    countBytes(b, 10, 59_999, 60_000);
    countBytes(b, 20, 60_000, 60_000);
    countBytes(b, 30, 90_000, 60_000);
    expect([b.first, b.second]).toEqual([10, 50]);
  });

  test("the run exits 1 on any miss, 0 with none", () => {
    expect(exitCode(budgetVerdict(pass))).toBe(0);
    expect(exitCode(budgetVerdict({ ...pass, errors: 1 }))).toBe(1);
    expect(exitCode(budgetVerdict({ ...pass, kbps: rateStats([41]) }))).toBe(1);
  });

  test("rates: mean, p95 and max", () => {
    expect(rateStats([])).toBeNull();
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(rateStats(twenty)).toEqual({ mean: 10.5, p95: 19, max: 20, count: 20 });
  });

  test("a run within every budget passes; each miss is named", () => {
    expect(budgetVerdict(pass)).toEqual([]);
    expect(budgetVerdict({ ...pass, errors: 2 })).toEqual(["2 error(s)"]);
    expect(budgetVerdict({ ...pass, joins: 199 })).toEqual(["only 199 of 200 bots joined"]);
    expect(budgetVerdict({ ...pass, tick: null })).toEqual(["server stats unavailable"]);
    expect(budgetVerdict({ ...pass, tick: { p50: 1, p95: TICK_P95_BUDGET_MS } })).toEqual([`tick p95 10.00 ms is not under ${TICK_P95_BUDGET_MS} ms`]);
    expect(budgetVerdict({ ...pass, tick: { p50: null, p95: null } })).toEqual(["no tick p95 measured"]);
    expect(budgetVerdict({ ...pass, kbps: rateStats([30, KBPS_PER_PLAYER_BUDGET + 0.1]) })).toEqual(["a player received 40.1 KB/s, over 40 KB/s"]);
    expect(budgetVerdict({ ...pass, kbps: rateStats([KBPS_PER_PLAYER_BUDGET]) })).toEqual([]);
    expect(budgetVerdict({ ...pass, kbps: null })).toEqual(["no per-player bandwidth measured"]);
    // No players: the players' gates do not apply.
    expect(budgetVerdict({ ...pass, joins: 0, count: 0, tick: { p50: null, p95: null }, kbps: null })).toEqual([]);
  });

  test("watchers (#119) are held to the per-player budget, second-half max, with or without players", () => {
    const watched = { ...pass, watchers: 300, watching: 300, watcherKbps: rateStats([20, 39])! };
    expect(budgetVerdict(watched)).toEqual([]);
    expect(budgetVerdict({ ...watched, watcherKbps: rateStats([20, 41]) })).toEqual(["a watcher received 41.0 KB/s, over 40 KB/s"]);
    expect(budgetVerdict({ ...watched, watching: 260 })).toEqual(["only 260 of 300 watchers watching"]);
    expect(budgetVerdict({ ...watched, watcherKbps: null })).toEqual(["no per-watcher bandwidth measured"]);
    // --count 0 --watchers n: an empty server's demo arena is gated too.
    const demo = { ...watched, joins: 0, count: 0, kbps: null };
    expect(budgetVerdict(demo)).toEqual([]);
    expect(budgetVerdict({ ...demo, watcherKbps: rateStats([41]) })).toEqual(["a watcher received 41.0 KB/s, over 40 KB/s"]);
    // No watchers asked for: nothing about them.
    expect(budgetVerdict({ ...pass, watcherKbps: rateStats([99]) })).toEqual([]);
  });

  test("the summary prints per-player KB/s, memory, a budget line per gate and the verdict", () => {
    const tally = createTally();
    tally.joins = 2;
    tally.kbps.push(20, 45);
    tally.kbpsFirst.push(10, 12);
    tally.memory = { rssMb: 80.5, heapUsedMb: 30 };
    tally.serverArenas = 1;
    const text = formatSummary({ url: "u", count: 2, seconds: 120, policy: "aimer", watchers: 0 }, tally, 120, { p50: 1, p95: 2 }).join("\n");
    expect(text).toContain("mean 32.5 KB/s, p95 45.0 KB/s, max 45.0 KB/s over 2 bot(s)");
    expect(text).toContain("rss 80.5 MB");
    expect(text).toContain("first half, not gated: bugs still ramping up): mean 11.0 KB/s, max 12.0 KB/s");
    expect(text).toContain("budget: tick p95 under 10 ms: pass");
    expect(text).toContain("budget: at most 40 KB/s per player: MISS");
    expect(text).toContain("budget: 0 errors: pass");
    expect(text).toContain("verdict: MISS (a player received 45.0 KB/s, over 40 KB/s)");
  });
});
