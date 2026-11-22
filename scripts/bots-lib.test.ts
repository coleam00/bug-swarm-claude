import { describe, expect, test } from "bun:test";
import { BUG_KINDS, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createRng } from "../src/shared/arena/rng";
import { stepPlayer } from "../src/shared/arena/sim";
import { TEAMS } from "../src/server/rules";
import type { Snapshot, SnapshotBug } from "../src/shared/arena/protocol";
import { createObservationTracker } from "./bots-lib";
import { AIM_TURN, WALL_AVOID, botName, botTeam, createTally, createWander, formatSummary, parseBotsArgs, stepWander, watcherRates, wsUrl } from "./bots-lib";

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
    s: [],
    e: [],
    k: [],
    d: [],
    f: tick === 10 ? [[1, 0, 700, 710, 200]] : [],
    w: 1,
    me: { sc: 0, ki: 0, st: 0, mu: 1, he: 0.42, lk: 1, hl: 2, al, dk: 0, dc: 0, dn: 0, fx: [0, 0] },
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
    w: 4,
    me: { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 1, dk: 0, dc: 0, dn: 0, fx: [0, 0] },
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

test("the summary gives each watcher's received KB/s, mean and max", () => {
  expect(watcherRates([])).toBeNull();
  expect(watcherRates([
    { bytes: 300_000, seconds: 10 },
    { bytes: 500_000, seconds: 10 },
  ])).toEqual({ mean: 40, max: 50 });
  const tally = createTally();
  tally.watchers.push({ bytes: 650_000, seconds: 10 });
  const args = { url: "u", count: 0, seconds: 10, policy: "aimer" as const, watchers: 2 };
  tally.watchers.push({ bytes: 250_000, seconds: 10 });
  const text = formatSummary(args, tally, 10, null).join(" ");
  expect(text).toContain("2 of 2");
  expect(text).toContain("45.0"); // the mean
  expect(text).toContain("65.0"); // the max
  expect(formatSummary({ ...args, watchers: 0 }, tally, 10, null).join(" ")).not.toContain("watchers:");
});
