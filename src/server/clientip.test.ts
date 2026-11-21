import { expect, test } from "bun:test";
import { pickClientIp } from "./app";

const PEER = "100.64.0.1";
/** The client IP for these request headers, with `hops` trusted proxies. */
function pick(headers: Record<string, string>, hops: number): string {
  return pickClientIp((name) => headers[name], () => PEER, hops);
}

test("hops 0 (the default): X-Real-IP, else the rightmost X-Forwarded-For entry, else the peer", () => {
  expect(pick({ "x-real-ip": " 9.9.9.9 ", "x-forwarded-for": "1.1.1.1" }, 0)).toBe("9.9.9.9");
  expect(pick({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" }, 0)).toBe("203.0.113.7");
  expect(pick({ "x-real-ip": "", "x-forwarded-for": "203.0.113.7" }, 0)).toBe("203.0.113.7");
  expect(pick({}, 0)).toBe(PEER);
  expect(pick({ "x-forwarded-for": "1.2.3.4, " }, 0)).toBe(PEER);
});

test("hops 1: the entry the one proxy appended, whatever the client prepends; X-Real-IP is ignored", () => {
  expect(pick({ "x-forwarded-for": "203.0.113.7" }, 1)).toBe("203.0.113.7");
  expect(pick({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 203.0.113.7" }, 1)).toBe("203.0.113.7");
  expect(pick({ "x-forwarded-for": "5.5.5.5,203.0.113.7", "x-real-ip": "9.9.9.9" }, 1)).toBe("203.0.113.7");
  expect(pick({ "x-real-ip": "9.9.9.9" }, 1)).toBe(PEER);
});

test("hops 2: the second entry from the right; prepending changes nothing; too few entries is the peer", () => {
  expect(pick({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }, 2)).toBe("198.51.100.4");
  expect(pick({ "x-forwarded-for": "spoof, 198.51.100.4, 10.0.0.1" }, 2)).toBe("198.51.100.4");
  expect(pick({ "x-forwarded-for": "7.7.7.7, 8.8.8.8, spoof, 198.51.100.4, 10.0.0.1" }, 2)).toBe("198.51.100.4");
  expect(pick({ "x-forwarded-for": "198.51.100.4" }, 2)).toBe(PEER);
});

test("an IPv6 entry is accepted", () => {
  expect(pick({ "x-forwarded-for": "1.1.1.1, 2001:db8::1" }, 1)).toBe("2001:db8::1");
});

test("a missing or malformed header is the peer, and never throws", () => {
  const bad = ["", "garbage", "1.2.3.4,,", ", ,", "203.0.113.7 extra", Array.from({ length: 2000 }, () => "x").join(",")];
  for (const hops of [1, 2]) {
    expect(pick({}, hops)).toBe(PEER);
    for (const xff of bad) expect(pick({ "x-forwarded-for": xff }, hops)).toBe(PEER);
  }
  const throwing = () => {
    throw new Error("no headers");
  };
  expect(pickClientIp(throwing, () => PEER, 0)).toBe(PEER);
  expect(pickClientIp(throwing, () => PEER, 1)).toBe(PEER);
});
