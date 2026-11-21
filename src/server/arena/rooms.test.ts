import { describe, expect, test } from "bun:test";
import { INPUT_BUFFER, INPUT_STALE_TICKS, MAX_PLAYERS_PER_ARENA, TICK_MS } from "../../shared/arena/constants";
import type { ServerMessage, Snapshot } from "../../shared/arena/protocol";
import type { Input } from "../../shared/arena/sim";
import { Rooms } from "./rooms";

/** Rooms on a fake clock and fake timers: `tick()` fires every running timer once. */
function setup() {
  let now = 1_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const rooms = new Rooms({
    now: () => now,
    clock: () => 0,
    buildId: "test-build",
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
  test("20 players share arena 1; the 21st opens arena 2", () => {
    const { rooms, timers } = setup();
    for (let i = 0; i < MAX_PLAYERS_PER_ARENA; i++) expect(rooms.join(`p${i}`, "tabs", client().send).room).toBe(1);
    expect(rooms.join("p20", "spaces", client().send).room).toBe(2);
    expect(timers.size).toBe(2);
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 1, players: 20, bots: 0 }, { id: 2, players: 1, bots: 0 }], players: 21 });
  });

  test("a player joins the fullest arena with room", () => {
    const { rooms } = setup();
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push(rooms.join(`p${i}`, "tabs", client().send).entity);
    // Arena 1 full, arena 2 has 2. One leaves arena 1: the next joins arena 1 (19 > 2).
    rooms.leave(1, ids[0]!);
    expect(rooms.join("again", "tabs", client().send).room).toBe(1);
    // Both full-ish: 20 and 2. The next goes to arena 2.
    expect(rooms.join("next", "tabs", client().send).room).toBe(2);
  });

  test("the welcome names you, your arena, the build, the world and everyone there", () => {
    const { rooms } = setup();
    rooms.join("Ada", "tabs", client().send);
    const { welcome, entity } = rooms.join("Bob", "spaces", client().send);
    expect(welcome).toEqual({
      t: "welcome",
      v: 1,
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
    const ja = rooms.join("Ada", "tabs", a.send);
    const jb = rooms.join("Bob", "spaces", b.send);
    expect(a.got).toEqual([{ t: "event", kind: "join", id: jb.entity, name: "Bob", team: "spaces" }]);
    expect(b.got).toEqual([]);
    rooms.leave(jb.room, jb.entity);
    expect(a.got.at(-1)).toEqual({ t: "event", kind: "leave", id: jb.entity });
    expect(timers.size).toBe(1);
    rooms.leave(ja.room, ja.entity);
    expect(timers.size).toBe(0);
    expect(rooms.stats().arenas).toEqual([]);
    // A new join opens a fresh arena with a new id.
    expect(rooms.join("Cy", "tabs", client().send).room).toBe(2);
  });

  test("close stops every timer", () => {
    const { rooms, timers } = setup();
    for (let i = 0; i < 25; i++) rooms.join(`p${i}`, "tabs", client().send);
    rooms.close();
    expect(timers.size).toBe(0);
  });
});

describe("ticking", () => {
  test("every member gets a snapshot of everyone with its own ack", () => {
    const { rooms, tick } = setup();
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", a.send);
    const jb = rooms.join("Bob", "spaces", b.send);
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
    const j = rooms.join("Ada", "tabs", a.send);
    for (const seq of [1, 2, 2, 1, 3]) rooms.input(j.room, j.entity, input(seq));
    tick(4);
    expect(snapshots(a.got).map((s) => s.ack)).toEqual([1, 2, 3, 3]);
  });

  test("a full queue drops its oldest input", () => {
    const { rooms, tick } = setup();
    const a = client();
    const j = rooms.join("Ada", "tabs", a.send);
    for (let seq = 1; seq <= INPUT_BUFFER + 2; seq++) rooms.input(j.room, j.entity, input(seq));
    tick(INPUT_BUFFER);
    expect(snapshots(a.got).map((s) => s.ack)).toEqual([3, 4, 5, 6]);
  });

  test("a held input repeats, and its move stops after INPUT_STALE_TICKS with nothing new", () => {
    const { rooms, tick } = setup();
    const a = client();
    const j = rooms.join("Ada", "tabs", a.send);
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
    const j = rooms.join("Ada", "tabs", client().send);
    rooms.input(j.room, j.entity, input(1, 5, 5));
    tick(10);
    const p = rooms.room(j.room)!.state.players[0]!;
    expect(Math.hypot(p.vx, p.vy)).toBeCloseTo(300, 9);
  });

  test("a late timer catches up at most 2 ticks; further lag is dropped", () => {
    const { rooms } = setup();
    rooms.join("Ada", "tabs", client().send);
    const room = rooms.room(1)!;
    const start = 1_000_000;
    expect(room.advance(start + TICK_MS * 5)).toBe(2);
    expect(room.state.tick).toBe(2);
    expect(room.advance(start + TICK_MS * 5 + 10)).toBe(0);
    expect(room.advance(start + TICK_MS * 6)).toBe(1);
  });
});
