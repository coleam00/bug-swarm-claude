import { describe, expect, test } from "bun:test";
import { checkName, checkScore, isUpgradeId, MAX_UPGRADES } from "../src/server/rules";
import {
  ROUTES,
  claimFor,
  formatSummary,
  loadName,
  loadPlayerId,
  parseLoadArgs,
  summarize,
  verdict,
  type Sample,
} from "./load-lib";

describe("parseLoadArgs", () => {
  test("defaults to 500 players for 60 seconds, and strips a trailing slash", () => {
    expect(parseLoadArgs(["--url", "http://127.0.0.1:3000/"])).toEqual({
      url: "http://127.0.0.1:3000",
      players: 500,
      seconds: 60,
    });
  });

  test("takes both flag forms and skips a bare --", () => {
    expect(parseLoadArgs(["--", "--url=https://example.test", "--players", "20", "--seconds=10"])).toEqual({
      url: "https://example.test",
      players: 20,
      seconds: 10,
    });
  });

  test("refuses a missing or bad --url", () => {
    expect(() => parseLoadArgs([])).toThrow("--url is required");
    expect(() => parseLoadArgs(["--players", "5"])).toThrow("--url is required");
    expect(() => parseLoadArgs(["--url", "not a url"])).toThrow("not a URL");
    expect(() => parseLoadArgs(["--url", "ftp://host"])).toThrow("http or https");
    expect(() => parseLoadArgs(["--url"])).toThrow("needs a value");
  });

  test("refuses players and seconds out of range or not whole", () => {
    const url = ["--url", "http://h"];
    for (const bad of ["0", "5001", "1.5", "-3", "abc", ""]) {
      expect(() => parseLoadArgs([...url, "--players", bad])).toThrow("--players");
    }
    for (const bad of ["4", "3601", "2.5", "x"]) {
      expect(() => parseLoadArgs([...url, `--seconds=${bad}`])).toThrow("--seconds");
    }
    expect(parseLoadArgs([...url, "--players", "5000", "--seconds", "5"])).toMatchObject({ players: 5000, seconds: 5 });
    expect(parseLoadArgs([...url, "--players", "1", "--seconds", "3600"])).toMatchObject({ players: 1, seconds: 3600 });
  });

  test("refuses an unknown flag or a stray argument", () => {
    expect(() => parseLoadArgs(["--url", "http://h", "--rate", "5"])).toThrow("unknown flag --rate");
    expect(() => parseLoadArgs(["--url", "http://h", "extra"])).toThrow("unexpected argument");
  });
});

describe("load players", () => {
  test("every load name passes the real name rules and starts with load-", () => {
    for (let i = 0; i < 5000; i++) {
      const name = loadName(i);
      expect(name.startsWith("load-")).toBe(true);
      expect(checkName(name)).toEqual({ ok: true, name });
    }
  });

  test("player ids fit the server's id pattern", () => {
    for (const i of [0, 1, 499, 4999]) expect(loadPlayerId(i)).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  });
});

describe("claimFor", () => {
  // A small seeded generator, so the claims are the same on every run.
  function seeded(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }

  test("passes the server's plausibility check for runs of 1 to 120 seconds", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      const rand = seeded(seed);
      for (let elapsed = 1; elapsed <= 120; elapsed++) {
        const claim = claimFor(elapsed, rand);
        expect(checkScore(claim, elapsed)).toEqual({ ok: true });
        expect(claim.upgrades.length).toBeLessThanOrEqual(MAX_UPGRADES);
        expect(claim.upgrades.every(isUpgradeId)).toBe(true);
      }
    }
  });

  test("passes at the extremes of the generator", () => {
    for (const r of [0, 0.999999]) {
      for (const elapsed of [1, 37.9, 120]) expect(checkScore(claimFor(elapsed, () => r), elapsed)).toEqual({ ok: true });
    }
  });

  test("half a second gives an empty run that still passes", () => {
    const claim = claimFor(0.5, () => 0.5);
    expect(claim).toMatchObject({ seconds: 0, squashes: 0, score: 0, upgrades: [] });
    expect(checkScore(claim, 0.5)).toEqual({ ok: true });
  });
});

const top = ROUTES.top.label;
const start = ROUTES.start.label;

function samples(route: string, ms: number[], status: number | "error" = 200): Sample[] {
  return ms.map((m) => ({ route, status, ms: m }));
}

describe("summarize", () => {
  test("nearest-rank percentiles on 1..100", () => {
    const list = Array.from({ length: 100 }, (_, i) => 100 - i); // unsorted on purpose
    const s = summarize(samples(top, list));
    const row = s.routes.find((r) => r.route === top)!;
    expect(row).toMatchObject({ requests: 100, p50: 50, p95: 95, p99: 99, statuses: { "200": 100 } });
    expect(s.overall).toMatchObject({ requests: 100, p50: 50, p95: 95, p99: 99 });
  });

  test("one sample is every percentile; a route with none has nulls", () => {
    const s = summarize(samples(top, [7]));
    expect(s.routes.find((r) => r.route === top)).toMatchObject({ requests: 1, p50: 7, p95: 7, p99: 7 });
    expect(s.routes.find((r) => r.route === start)).toMatchObject({
      requests: 0,
      statuses: {},
      p50: null,
      p95: null,
      p99: null,
    });
    expect(s.routes.map((r) => r.route)).toEqual(Object.values(ROUTES).map((r) => r.label));
  });

  test("counts each status, with network errors and timeouts as error", () => {
    const s = summarize([...samples(start, [1, 2]), ...samples(start, [3], 429), ...samples(start, [5000], "error")]);
    expect(s.routes.find((r) => r.route === start)!.statuses).toEqual({ "200": 2, "429": 1, error: 1 });
    expect(s.overall.requests).toBe(4);
  });

  test("the fast share counts requests under 200 ms", () => {
    expect(summarize(samples(top, [199.9, 200, 10, 300])).overall.fastShare).toBe(0.5);
  });
});

describe("verdict", () => {
  test("passes at exactly 95% under 200 ms", () => {
    const s = summarize([...samples(top, Array(950).fill(10)), ...samples(top, Array(50).fill(250))]);
    expect(verdict(s)).toEqual({ pass: true, failed: [] });
  });

  test("fails at 94.9%", () => {
    const s = summarize([...samples(top, Array(949).fill(10)), ...samples(top, Array(51).fill(250))]);
    expect(verdict(s)).toEqual({ pass: false, failed: ["94.9% of requests under 200 ms (needs 95.0%)"] });
  });

  test("fails on a single 5xx", () => {
    const s = summarize([...samples(top, Array(999).fill(10)), ...samples(start, [10], 500)]);
    expect(verdict(s)).toEqual({ pass: false, failed: ["1 5xx response"] });
  });

  test("fails on a single network error or timeout", () => {
    const s = summarize([...samples(top, Array(999).fill(10)), ...samples(start, [10], "error")]);
    expect(verdict(s)).toEqual({ pass: false, failed: ["1 network error or timeout"] });
  });

  test("fails with no requests at all", () => {
    expect(verdict(summarize([])).pass).toBe(false);
  });
});

test("formatSummary prints a row per route, an overall row, and the verdict", () => {
  const lines = formatSummary(summarize([...samples(top, [1, 2, 3]), ...samples(start, [4], 500)]));
  expect(lines[0]).toMatch(/^route\s+requests\s+statuses\s+p50 ms\s+p95 ms\s+p99 ms\s+<200 ms$/);
  expect(lines.length).toBe(1 + Object.keys(ROUTES).length + 1 + 1);
  expect(lines.find((l) => l.startsWith(top))).toMatch(/GET \/api\/top\s+3\s+200:3\s+2\.0\s+3\.0\s+3\.0\s+100\.0%/);
  expect(lines.find((l) => l.startsWith(start))).toContain("500:1");
  expect(lines.at(-2)).toMatch(/^overall\s+4\s+200:3 500:1/);
  expect(lines.at(-1)).toBe("FAIL: 1 5xx response");
});
