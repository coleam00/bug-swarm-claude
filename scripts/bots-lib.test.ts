import { describe, expect, test } from "bun:test";
import { WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import { createRng } from "../src/shared/arena/rng";
import { stepPlayer } from "../src/shared/arena/sim";
import { TEAMS } from "../src/server/rules";
import { AIM_TURN, WALL_AVOID, botName, botTeam, createTally, createWander, formatSummary, parseBotsArgs, stepWander, wsUrl } from "./bots-lib";

describe("parseBotsArgs", () => {
  test("defaults to 18 bots for 60 seconds, and strips a trailing slash", () => {
    expect(parseBotsArgs(["--url", "http://127.0.0.1:3000/"])).toEqual({ url: "http://127.0.0.1:3000", count: 18, seconds: 60 });
  });

  test("takes both flag forms and skips a bare --", () => {
    expect(parseBotsArgs(["--", "--url=https://x.test", "--count", "5", "--seconds=10"])).toEqual({ url: "https://x.test", count: 5, seconds: 10 });
  });

  test("refuses a missing url, unknown flags and anything but positive whole numbers", () => {
    for (const argv of [[], ["--count", "3"], ["--url", "ftp://x"], ["--url", "nope"], ["--url", "http://x", "--count", "0"], ["--url", "http://x", "--seconds", "1.5"], ["--url", "http://x", "--count", "-2"], ["--url", "http://x", "--policy", "aimer"], ["--url"]]) {
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
  const text = formatSummary({ url: "http://127.0.0.1:3000", count: 18, seconds: 60 }, tally, 60, { p50: 0.12, p95: 0.4 }).join(" ");
  for (const part of ["18 of 18", "360.0/s", "20.0/s", "errors: 3", "close 1006 x2", "error name x1", "0.12", "0.40"]) {
    expect(text).toContain(part);
  }
  expect(formatSummary({ url: "u", count: 1, seconds: 1 }, createTally(), 1, null).join(" ")).toContain("unavailable");
});
