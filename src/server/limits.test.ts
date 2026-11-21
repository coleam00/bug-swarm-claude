import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_STARTS_PER_PLAYER, RUN_STARTS_PER_WINDOW, createApp } from "./app";
import { openDb } from "./db";
import { proxyHops, serverOptions, startLimits } from "./limits";
import { TEAMS } from "./rules";

test("unset or empty is the real limits: 300 per client IP, 40 per player", () => {
  expect(RUN_STARTS_PER_WINDOW).toBe(300);
  expect(RUN_STARTS_PER_PLAYER).toBe(40);
  expect(startLimits({})).toEqual({ perIp: 300, perPlayer: 40, raised: false });
  expect(startLimits({ RUN_STARTS_PER_WINDOW: "" })).toEqual({ perIp: 300, perPlayer: 40, raised: false });
});

test("a positive whole number raises both, for the load test", () => {
  expect(startLimits({ RUN_STARTS_PER_WINDOW: "5000" })).toEqual({ perIp: 5000, perPlayer: 5000, raised: true });
  expect(startLimits({ RUN_STARTS_PER_WINDOW: "1" })).toEqual({ perIp: 1, perPlayer: 1, raised: true });
});

test("anything else refuses to start, naming the variable", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "1e3", " 5", "0x10", "05", "99999999999999999999"]) {
    expect(() => startLimits({ RUN_STARTS_PER_WINDOW: bad })).toThrow("RUN_STARTS_PER_WINDOW");
  }
});

test("TRUST_PROXY_HOPS: unset or empty is 0; a small whole number is that", () => {
  expect(proxyHops({})).toBe(0);
  expect(proxyHops({ TRUST_PROXY_HOPS: "" })).toBe(0);
  expect(proxyHops({ TRUST_PROXY_HOPS: "0" })).toBe(0);
  expect(proxyHops({ TRUST_PROXY_HOPS: "1" })).toBe(1);
  expect(proxyHops({ TRUST_PROXY_HOPS: "2" })).toBe(2);
  expect(proxyHops({ TRUST_PROXY_HOPS: "10" })).toBe(10);
});

test("TRUST_PROXY_HOPS: anything else refuses to start, naming the variable", () => {
  for (const bad of ["-1", "1.5", "abc", " 1", "01", "11", "99"]) {
    expect(() => proxyHops({ TRUST_PROXY_HOPS: bad })).toThrow("TRUST_PROXY_HOPS");
  }
});

test("serverOptions wires TRUST_PROXY_HOPS and the start limits from the environment into the app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-test-"));
  const db = openDb(join(dir, "app.db"));
  try {
    const { options, startup } = serverOptions({ TRUST_PROXY_HOPS: "1", RUN_STARTS_PER_WINDOW: "1" }, () => "100.64.0.1");
    expect(startup).toEqual([
      "run start limits set to 1 per IP and per player per 10 min (load testing only)",
      "trusting 1 proxy hop(s) in X-Forwarded-For",
    ]);
    const app = createApp(db, { ...options, log: () => {} });
    // Every viewer shares X-Real-IP here, so only hops 1 tells them apart.
    const start = (n: number, xff: string) =>
      app.request("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9", "x-forwarded-for": xff },
        body: JSON.stringify({ playerId: `player-000${n}`, name: "Robo", team: TEAMS[0] }),
      });
    expect((await start(1, "6.6.6.6, 198.51.100.1")).status).toBe(200);
    expect((await start(2, "7.7.7.7, 198.51.100.2")).status).toBe(200);
    expect((await start(3, "8.8.8.8, 198.51.100.1")).status).toBe(429); // the limit of 1 is wired too
    expect(serverOptions({}, () => "x").startup).toEqual([]);
  } finally {
    db.close(); // close before deleting: Windows refuses to delete an open file
    rmSync(dir, { recursive: true, force: true });
  }
});
