// The per-address gate with a hand-stepped clock (ws.test.ts covers it over real sockets).
import { expect, test } from "bun:test";
import { JOINS_PER_ADDRESS_PER_MINUTE, MAX_PEOPLE, MAX_SOCKETS_PER_ADDRESS } from "../../shared/arena/constants";
import { GATE_WINDOW_MS, createAddressGate, createOpenGate } from "./gate";

const A = "203.0.113.7";
const B = "198.51.100.4";

function gate() {
  let t = 1_000_000;
  const g = createAddressGate({ maxSockets: MAX_SOCKETS_PER_ADDRESS, joinsPerMinute: JOINS_PER_ADDRESS_PER_MINUTE, now: () => t });
  return { g, advance: (ms: number) => void (t += ms) };
}

test("the owner's limits: 12 sockets and 30 joins a minute per address, 600 people", () => {
  expect([MAX_SOCKETS_PER_ADDRESS, JOINS_PER_ADDRESS_PER_MINUTE, MAX_PEOPLE]).toEqual([12, 30, 600]);
});

test("the 31st join in 60 s is refused; the window slides", () => {
  const { g, advance } = gate();
  g.open(A);
  for (let i = 0; i < 30; i++) {
    expect(g.join(A)).toBe(true);
    advance(1000); // joins at 0 s .. 29 s
  }
  expect(g.join(A)).toBe(false); // 30 s
  expect(g.join(B)).toBe(true);
  advance(GATE_WINDOW_MS - 30_000); // 60 s: the join at 0 s has left the window
  expect(g.join(A)).toBe(true);
  expect(g.join(A)).toBe(false);
  advance(1000); // 61 s: the one at 1 s has left too
  expect(g.join(A)).toBe(true);
});

test("an address is forgotten once it has no socket, no join and no refusal logged in the window", () => {
  const { g, advance } = gate();
  g.open(A);
  g.close(A);
  expect(g.size).toBe(0); // never joined: forgotten at once
  g.open(A);
  g.join(A);
  g.close(A);
  expect(g.size).toBe(1); // its join still counts for a minute
  advance(GATE_WINDOW_MS + 1);
  g.open(B); // the next open sweeps, at most once a minute
  expect(g.size).toBe(1);
  expect(g.sockets(B)).toBe(1);
  g.close(B);
  expect(g.size).toBe(0);
});

test("a refusal is logged at most once per address per minute", () => {
  const { g, advance } = gate();
  expect(g.shouldLog(A)).toBe(true);
  expect(g.shouldLog(A)).toBe(false);
  expect(g.shouldLog(B)).toBe(true);
  advance(GATE_WINDOW_MS);
  expect(g.shouldLog(A)).toBe(true);
  advance(GATE_WINDOW_MS);
  g.open(B);
  g.close(B);
  expect(g.size).toBe(0);
});

test("the open gate (BUG_SWARM_ALLOW_LOAD=1) allows everything and remembers nothing", () => {
  const g = createOpenGate();
  for (let i = 0; i < 1000; i++) {
    expect(g.open(A)).toBe(true);
    expect(g.join(A)).toBe(true);
  }
  expect(g.size).toBe(0);
});
