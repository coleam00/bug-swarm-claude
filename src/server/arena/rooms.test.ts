import { describe, expect, test } from "bun:test";
import { INPUT_BUFFER, INPUT_STALE_TICKS, MAX_PLAYERS_PER_ARENA, PROTOCOL_VERSION, TICK_MS } from "../../shared/arena/constants";
import type { ServerMessage, Snapshot } from "../../shared/arena/protocol";
import type { Input } from "../../shared/arena/sim";
import { HITS_PER_LIFE } from "../../shared/arena/constants";
import { placeBug } from "../../shared/arena/testkit";
import { meOf, type LifeRecord } from "./room";
import { Rooms } from "./rooms";

const INFO = { playerKey: "0".repeat(32), touch: false };

/** Rooms on a fake clock and fake timers: `tick()` fires every running timer once. */
function setup(saveLife?: (r: LifeRecord) => void) {
  let now = 1_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const rooms = new Rooms({
    now: () => now,
    clock: () => 0,
    buildId: "test-build",
    saveLife,
    startTimer: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return () => timers.delete(id);
    },
  });
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      now += TICK_MS;
      for (const fn of [...timers.values()]) fn();
    }
  };
  return { rooms, timers, tick };
}

function client() {
  const got: ServerMessage[] = [];
  return { got, send: (m: string) => void got.push(JSON.parse(m) as ServerMessage) };
}

const input = (seq: number, mx = 1, my = 0): Input => ({ seq, mx, my, aim: 0, fire: false, dash: false });
const snapshots = (got: ServerMessage[]) => got.filter((m): m is Snapshot => m.t === "snapshot");

describe("joining", () => {
  test("a player joins the fullest arena with room", () => {
    const { rooms } = setup();
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push(rooms.join(`p${i}`, "tabs", INFO, client().send).entity);
    // Arena 1 full, arena 2 has 2. One leaves arena 1: the next joins arena 1 (19 > 2).
    rooms.leave(1, ids[0]!);
    expect(rooms.join("again", "tabs", INFO, client().send).room).toBe(1);
    // Both full-ish: 20 and 2. The next goes to arena 2.
    expect(rooms.join("next", "tabs", INFO, client().send).room).toBe(2);
  });

  test("the welcome names you, your arena, the build, the world and everyone there", () => {
    const { rooms } = setup();
    rooms.join("Ada", "tabs", INFO, client().send);
    const { welcome, entity } = rooms.join("Bob", "spaces", INFO, client().send);
    expect(welcome).toEqual({
      t: "welcome",
      v: PROTOCOL_VERSION,
      you: entity,
      arena: 1,
      build: "test-build",
      world: { w: 2400, h: 2400 },
      tickMs: 50,
      tick: 0,
      roster: [
        { id: 1, name: "Ada", team: "tabs" },
        { id: 2, name: "Bob", team: "spaces" },
      ],
    });
  });

  test("the others get join and leave events; the last leave closes the arena and its timer", () => {
    const { rooms, timers } = setup();
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", INFO, a.send);
    const jb = rooms.join("Bob", "spaces", INFO, b.send);
    expect(a.got).toEqual([{ t: "event", kind: "join", id: jb.entity, name: "Bob", team: "spaces" }]);
    expect(b.got).toEqual([]);
    rooms.leave(jb.room, jb.entity);
    expect(a.got.at(-1)).toEqual({ t: "event", kind: "leave", id: jb.entity });
    expect(timers.size).toBe(1);
    rooms.leave(ja.room, ja.entity);
    expect(timers.size).toBe(0);
    expect(rooms.stats().arenas).toEqual([]);
    // A new join opens a fresh arena with a new id.
    expect(rooms.join("Cy", "tabs", INFO, client().send).room).toBe(2);
  });

  test("close stops every timer", () => {
    const { rooms, timers } = setup();
    for (let i = 0; i < 25; i++) rooms.join(`p${i}`, "tabs", INFO, client().send);
    rooms.close();
    expect(timers.size).toBe(0);
  });
});

describe("ticking", () => {
  test("every member gets a snapshot of everyone with its own ack", () => {
    const { rooms, tick } = setup();
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", INFO, a.send);
    const jb = rooms.join("Bob", "spaces", INFO, b.send);
    rooms.input(ja.room, ja.entity, input(7));
    tick();
    const sa = snapshots(a.got).at(-1)!;
    const sb = snapshots(b.got).at(-1)!;
    expect([sa.tick, sa.ack, sb.ack]).toEqual([1, 7, 0]);
    expect(sa.p.map((p) => p[0])).toEqual([ja.entity, jb.entity]);
    expect(sa.p).toEqual(sb.p);
    expect(sa.p[0]![3]).toBe(120); // Ada's vx after one step of mx = 1
  });

  test("one input per tick, in order; old and repeated sequence numbers are dropped", () => {
    const { rooms, tick } = setup();
    const a = client();
    const j = rooms.join("Ada", "tabs", INFO, a.send);
    for (const seq of [1, 2, 2, 1, 3]) rooms.input(j.room, j.entity, input(seq));
    tick(4);
    expect(snapshots(a.got).map((s) => s.ack)).toEqual([1, 2, 3, 3]);
  });

  test("a full queue drops its oldest input", () => {
    const { rooms, tick } = setup();
    const a = client();
    const j = rooms.join("Ada", "tabs", INFO, a.send);
    for (let seq = 1; seq <= INPUT_BUFFER + 2; seq++) rooms.input(j.room, j.entity, input(seq));
    tick(INPUT_BUFFER);
    expect(snapshots(a.got).map((s) => s.ack)).toEqual([3, 4, 5, 6]);
  });

  test("a held input repeats, and its move stops after INPUT_STALE_TICKS with nothing new", () => {
    const { rooms, tick } = setup();
    const a = client();
    const j = rooms.join("Ada", "tabs", INFO, a.send);
    rooms.input(j.room, j.entity, input(1));
    tick(INPUT_STALE_TICKS);
    const p = rooms.room(j.room)!.state.players[0]!;
    expect(p.input.mx).toBe(1);
    expect(p.vx).toBe(300);
    tick(1);
    expect(p.input.mx).toBe(0);
    tick(5);
    expect(p.vx).toBe(0);
  });

  test("inputs are clamped before they are stepped", () => {
    const { rooms, tick } = setup();
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    rooms.input(j.room, j.entity, input(1, 5, 5));
    tick(10);
    const p = rooms.room(j.room)!.state.players[0]!;
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(300, 9);
  });

  test("a late timer catches up at most 2 ticks; further lag is dropped", () => {
    const { rooms } = setup();
    rooms.join("Ada", "tabs", INFO, client().send);
    const room = rooms.room(1)!;
    const start = 1_000_000;
    expect(room.advance(start + TICK_MS * 5)).toBe(2);
    expect(room.state.tick).toBe(2);
    expect(room.advance(start + TICK_MS * 5 + 10)).toBe(0);
    expect(room.advance(start + TICK_MS * 6)).toBe(1);
  });
});

describe("lives", () => {
  test("a life that ends is saved once and only its player is told it is over", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup((r) => saved.push(r));
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", { playerKey: "a".repeat(32), touch: true }, a.send);
    rooms.join("Bob", "spaces", INFO, b.send);
    const room = rooms.room(ja.room)!;
    const p = room.state.players[0]!;
    tick(30);
    p.invulnTicks = 0;
    p.hits = HITS_PER_LIFE - 1;
    p.score = 120;
    p.kills = 9;
    p.budget = 0;
    placeBug(room.state, p.x + 5, p.y);
    tick();
    tick(5);
    expect(saved).toEqual([
      { playerKey: "a".repeat(32), name: "Ada", team: "tabs", touch: true, score: 120, kills: 9, seconds: 1.5, endedAtMs: 1_000_000 + 31 * TICK_MS },
    ]);
    const overs = (got: ServerMessage[]) => got.filter((m) => m.t === "event" && m.kind === "over");
    expect(overs(a.got)).toEqual([{ t: "event", kind: "over", id: ja.entity, score: 120, kills: 9, seconds: 1.5 }]);
    expect(overs(b.got)).toEqual([]);
    const last = snapshots(a.got).at(-1)!;
    expect(last.me).toMatchObject({ al: 0, hl: 0 });
    expect(last.p.find((r) => r[0] === ja.entity)![6]).toBe(0);
    // Leaving while out saves nothing more.
    rooms.leave(ja.room, ja.entity);
    expect(saved.length).toBe(1);
  });

  test("leaving in the middle of a life saves it once", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup((r) => saved.push(r));
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    rooms.join("Bob", "tabs", INFO, client().send);
    tick(20);
    rooms.leave(j.room, j.entity);
    rooms.leave(j.room, j.entity);
    expect(saved).toMatchObject([{ name: "Ada", seconds: 1, score: 0 }]);
  });

  test("a stale input stops firing as well as moving", () => {
    const { rooms, tick } = setup();
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    rooms.input(j.room, j.entity, { ...input(1, 0, 0), fire: true });
    tick(INPUT_STALE_TICKS);
    const p = rooms.room(j.room)!.state.players[0]!;
    expect(p.input.fire).toBe(true);
    tick(1);
    expect(p.input.fire).toBe(false);
  });
});

test("your own numbers in each snapshot: score, kills, streak and its multiplier, heat, lock, hits left", () => {
  const { rooms } = setup();
  const p = rooms.room(rooms.join("Ada", "tabs", INFO, client().send).room)!.state.players[0]!;
  p.score = 125;
  p.kills = 11;
  p.streak = 6;
  p.heat = 0.42;
  p.lockTicks = 3;
  p.hits = 1;
  const me = { sc: 0, ki: 0, st: 0, mu: 0, he: 0, lk: 0 as 0 | 1, hl: 0, al: 0 as 0 | 1 };
  expect(meOf(p, me)).toEqual({ sc: 125, ki: 11, st: 6, mu: 1.5, he: 0.42, lk: 1, hl: 2, al: 1 });
  p.lockTicks = 0;
  p.streak = 20;
  expect(meOf(p, me)).toMatchObject({ mu: 3, lk: 0 });
});
