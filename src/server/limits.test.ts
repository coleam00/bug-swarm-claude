import { expect, test } from "bun:test";
import { RUN_STARTS_PER_PLAYER, RUN_STARTS_PER_WINDOW } from "./app";
import { proxyHops, startLimits } from "./limits";

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
