import { describe, expect, test } from "bun:test";
import {
  DASH_COOLDOWN_TICKS,
  DASH_SPAWN_LOCK_TICKS,
  DASH_TICKS,
  FILL_TARGET,
  INPUT_BUFFER,
  INPUT_STALE_TICKS,
  MAX_PLAYERS_PER_ARENA,
  PROTOCOL_VERSION,
  TICK_MS,
  WAVE_S,
} from "../../shared/arena/constants";
import type { ServerMessage, Snapshot } from "../../shared/arena/protocol";
import type { Input } from "../../shared/arena/sim";
import { DOWN_TICKS, HITS_PER_LIFE, REVIVE_POINTS, REVIVE_TICKS } from "../../shared/arena/constants";
import { placeBug } from "../../shared/arena/testkit";
import { isBotName } from "../rules";
import { Room, meOf, type LifeRecord } from "./room";
import { Rooms, arenaSeed } from "./rooms";
import { createTickLog } from "./ticks";

const INFO = { playerKey: "0".repeat(32), touch: false };

/**
 * Rooms on a fake clock and fake timers: `tick()` fires every running timer once. No fill bots
 * unless `fillTo` is given, so the counts below are people only.
 */
function setup(saveLife?: (r: LifeRecord) => void, fillTo = 0) {
  let now = 1_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const rooms = new Rooms({
    now: () => now,
    clock: () => 0,
    buildId: "test-build",
    saveLife,
    fillTo,
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

  test("a dash press dropped with the oldest input is carried onto the next, and the snapshot shows the dash", () => {
    const { rooms, tick } = setup();
    const a = client();
    const b = client();
    const j = rooms.join("Ada", "tabs", INFO, a.send);
    rooms.join("Bob", "spaces", INFO, b.send);
    tick(DASH_SPAWN_LOCK_TICKS); // past the spawn lock
    let seq = 0;
    rooms.input(j.room, j.entity, { ...input(++seq), dash: true });
    for (let i = 0; i < INPUT_BUFFER; i++) rooms.input(j.room, j.entity, input(++seq));
    tick();
    const p = rooms.room(j.room)!.state.players[0]!;
    expect(p.dashTicks).toBe(DASH_TICKS);
    const mine = snapshots(a.got).at(-1)!;
    expect(mine.ack).toBe(2);
    expect([mine.me.dk, mine.me.dc]).toEqual([DASH_TICKS, DASH_COOLDOWN_TICKS]);
    // Everyone sees the dash in Ada's row.
    expect(snapshots(b.got).at(-1)!.p.find((r) => r[0] === j.entity)![8]).toBe(1);
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
    p.protectTicks = 0;
    p.hits = HITS_PER_LIFE - 1;
    p.score = 120;
    p.kills = 9;
    p.budget = 0;
    placeBug(room.state, p.x + 5, p.y);
    tick();
    // Down, not out: nothing saved yet. Then it bleeds out (as if DOWN_S had passed).
    expect([p.down, saved.length]).toEqual([true, 0]);
    p.downTick = room.state.tick - DOWN_TICKS;
    tick();
    tick(5);
    expect(saved).toEqual([
      { playerKey: "a".repeat(32), name: "Ada", team: "tabs", touch: true, score: 120, kills: 9, seconds: 1.55, endedAtMs: 1_000_000 + 32 * TICK_MS },
    ]);
    const overs = (got: ServerMessage[]) => got.filter((m) => m.t === "event" && m.kind === "over");
    expect(overs(a.got)).toEqual([{ t: "event", kind: "over", id: ja.entity, score: 120, kills: 9, seconds: 1.55 }]);
    expect(overs(b.got)).toEqual([]);
    const last = snapshots(a.got).at(-1)!;
    expect(last.me).toMatchObject({ al: 0, hl: 0 });
    expect(last.p.find((r) => r[0] === ja.entity)![6]).toBe(0);
    // Leaving while out saves nothing more.
    rooms.leave(ja.room, ja.entity);
    expect(saved.length).toBe(1);
  });

  test("endAll (the server stopping) ends and saves every life in progress, with its score, once", () => {
    const saved: LifeRecord[] = [];
    const { rooms, timers, tick } = setup((r) => saved.push(r));
    const key = (i: number) => i.toString(16).padStart(32, "0");
    // A full arena and one more player in a second.
    for (let i = 0; i <= MAX_PLAYERS_PER_ARENA; i++) rooms.join(`p${i}`, "tabs", { playerKey: key(i), touch: false }, client().send);
    expect(rooms.stats().arenas.map((a) => a.players)).toEqual([MAX_PLAYERS_PER_ARENA, 1]);
    const room = rooms.room(1)!;
    const [scorer, downed, out] = [room.state.players[0]!, room.state.players[1]!, room.state.players[2]!];
    tick(30);
    scorer.score = 70;
    scorer.kills = 4;
    // One player out (down, then bled out), one down and waiting for a revive.
    for (const p of [out, downed]) {
      p.invulnTicks = 0;
      p.protectTicks = 0;
      p.hits = HITS_PER_LIFE - 1;
      placeBug(room.state, p.x + 5, p.y);
      tick();
      expect(p.down).toBe(true);
    }
    out.downTick = room.state.tick - DOWN_TICKS;
    tick();
    expect([out.alive, downed.down]).toEqual([false, true]);
    expect(saved.map((r) => r.playerKey)).toEqual([key(2)]);
    saved.length = 0;

    expect(rooms.endAll()).toBe(MAX_PLAYERS_PER_ARENA);
    // Everyone with a life, the downed player and the one in the second arena included; not the out one.
    expect(saved.map((r) => r.playerKey).sort()).toEqual([...Array(MAX_PLAYERS_PER_ARENA + 1).keys()].filter((i) => i !== 2).map(key).sort());
    expect(saved.find((r) => r.playerKey === key(0))).toMatchObject({ name: "p0", score: 70, kills: 4 });
    expect(rooms.stats().arenas).toEqual([]);
    expect(timers.size).toBe(0);
    // Nothing is saved twice.
    expect(rooms.endAll()).toBe(0);
    expect(saved.length).toBe(MAX_PLAYERS_PER_ARENA);
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

  test("a down and a revive go to every member, down first, each before its tick's snapshot; the reviver's points are saved with its life", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup((r) => saved.push(r));
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", INFO, a.send);
    const jb = rooms.join("Bob", "spaces", { playerKey: "b".repeat(32), touch: false }, b.send);
    const room = rooms.room(ja.room)!;
    const [pa, pb] = [room.state.players[0]!, room.state.players[1]!];
    const quiet = () => {
      pa.budget = 0;
      pb.budget = 0;
    };
    quiet();
    tick();
    room.state.bugs.length = 0;
    pb.x = pa.x + 40;
    pb.y = pa.y;
    pa.invulnTicks = 0;
    pa.protectTicks = 0; // past spawn protection (#58)
    pa.hits = HITS_PER_LIFE - 1;
    pb.invulnTicks = 1000; // Bob can't be hit while he revives
    placeBug(room.state, pa.x - 5, pa.y);
    quiet();
    tick();
    const meOfA = snapshots(a.got).at(-1)!.me;
    expect(meOfA).toMatchObject({ al: 1, dn: 1, hl: 0 });
    expect(snapshots(b.got).at(-1)!.d).toEqual([[ja.entity, 9.95, 0, 0]]);
    for (let i = 0; i < REVIVE_TICKS; i++) {
      quiet();
      tick();
    }
    const kinds = (got: ServerMessage[]) => got.filter((m) => m.t !== "event" || m.kind === "down" || m.kind === "revive").map((m) => (m.t === "event" ? m.kind : m.t));
    for (const c of [a, b]) {
      const seen = kinds(c.got);
      const down = seen.indexOf("down");
      const revive = seen.indexOf("revive");
      // Each event comes before the snapshot of the tick it happened in, and after the one before.
      expect(seen.slice(down - 1, down + 2)).toEqual(["snapshot", "down", "snapshot"]);
      expect(seen.slice(revive - 1, revive + 2)).toEqual(["snapshot", "revive", "snapshot"]);
      expect(seen.filter((k) => k === "snapshot").length).toBe(REVIVE_TICKS + 2);
      expect(c.got.filter((m) => m.t === "event" && (m.kind === "down" || m.kind === "revive"))).toEqual([
        { t: "event", kind: "down", id: ja.entity },
        { t: "event", kind: "revive", id: ja.entity, by: jb.entity, points: REVIVE_POINTS },
      ]);
    }
    expect(snapshots(a.got).at(-1)!.me).toMatchObject({ al: 1, dn: 0, hl: 1 });
    expect(snapshots(a.got).at(-1)!.d).toEqual([]);
    expect(snapshots(b.got).at(-1)!.me.sc).toBe(REVIVE_POINTS);
    // Bob's revive points are in his life when it ends, saved under his (spaces) name.
    rooms.leave(jb.room, jb.entity);
    expect(saved).toMatchObject([{ playerKey: "b".repeat(32), team: "spaces", score: REVIVE_POINTS }]);
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

test("your own numbers in each snapshot: score, kills, streak and its multiplier, heat, lock, hits left, dash", () => {
  const { rooms } = setup();
  const p = rooms.room(rooms.join("Ada", "tabs", INFO, client().send).room)!.state.players[0]!;
  p.score = 125;
  p.kills = 11;
  p.streak = 6;
  p.heat = 0.42;
  p.lockTicks = 3;
  p.hits = 1;
  p.dashTicks = 2;
  p.dashCooldown = 27;
  const me = { sc: 0, ki: 0, st: 0, mu: 0, he: 0, lk: 0 as 0 | 1, hl: 0, al: 0 as 0 | 1, dk: 0, dc: 0, dn: 0 as 0 | 1 };
  expect(meOf(p, me)).toEqual({ sc: 125, ki: 11, st: 6, mu: 1.5, he: 0.42, lk: 1, hl: 2, al: 1, dk: 2, dc: 27, dn: 0 });
  p.lockTicks = 0;
  p.streak = 20;
  expect(meOf(p, me)).toMatchObject({ mu: 3, lk: 0 });
});

describe("fill bots (#66)", () => {
  const joins = (got: ServerMessage[]) => got.filter((m) => m.t === "event" && m.kind === "join");
  const leaves = (got: ServerMessage[]) => got.filter((m) => m.t === "event" && m.kind === "leave");
  const bots = (rooms: Rooms, id: number) => rooms.room(id)!.state.players.filter((p) => isBotName(p.name));
  /** Saves into `saved`, failing the test on any bot life. */
  const spy = (saved: LifeRecord[]) => (r: LifeRecord) => {
    expect(isBotName(r.name)).toBe(false);
    saved.push(r);
  };

  test("one person is topped up to 4 on the next tick, after their welcome; stats count people and bots apart", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    const a = client();
    const j = rooms.join("Ada", "tabs", INFO, a.send);
    expect(j.welcome.roster).toEqual([{ id: j.entity, name: "Ada", team: "tabs" }]);
    expect(a.got).toEqual([]);
    tick();
    // Three joins, then the tick's snapshot with all four.
    expect(a.got.map((m) => (m.t === "event" ? m.kind : m.t))).toEqual(["join", "join", "join", "snapshot"]);
    expect(joins(a.got)).toEqual([
      { t: "event", kind: "join", id: 2, name: "bot Ada", team: "spaces" },
      { t: "event", kind: "join", id: 3, name: "bot Linus", team: "tabs" },
      { t: "event", kind: "join", id: 4, name: "bot Grace", team: "spaces" },
    ]);
    expect(snapshots(a.got)[0]!.p.length).toBe(4);
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 1, players: 1, bots: 3 }], players: 1, bots: 3 });
    // Driven by the tick, with no socket: within 30 s the bots are killing bugs.
    tick(600);
    expect(bots(rooms, 1).reduce((n, p) => n + p.kills, 0)).toBeGreaterThan(0);
  });

  test("a person joining marks the newest bot, which leaves once its life ends (unsaved) and never respawns; a person leaving brings one back", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup(spy(saved), FILL_TARGET);
    const a = client();
    rooms.join("Ada", "tabs", INFO, a.send);
    tick();
    const jb = rooms.join("Bob", "spaces", INFO, client().send);
    const room = rooms.room(1)!;
    tick(3);
    // The marked bot plays on: 2 people and 3 bots until its life ends.
    expect(rooms.stats()).toMatchObject({ players: 2, bots: 3 });
    const grace = bots(rooms, 1).find((p) => p.name === "bot Grace")!;
    grace.invulnTicks = 0;
    grace.protectTicks = 0;
    grace.dashTicks = 0;
    grace.hits = HITS_PER_LIFE - 1;
    placeBug(room.state, grace.x + 5, grace.y);
    tick();
    expect(grace.down).toBe(true);
    grace.downTick = room.state.tick - DOWN_TICKS;
    tick();
    expect(grace.alive).toBe(false);
    expect(leaves(a.got)).toEqual([]);
    tick();
    expect(leaves(a.got)).toEqual([{ t: "event", kind: "leave", id: grace.id }]);
    tick(40);
    expect(room.state.players.some((p) => p.id === grace.id)).toBe(false);
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 1, players: 2, bots: 2 }], players: 2, bots: 2 });
    expect(saved).toEqual([]);
    // Bob leaves: Ada alone again is topped back up to 3 bots on the next tick.
    rooms.leave(1, jb.entity);
    tick();
    expect(joins(a.got).at(-1)).toMatchObject({ name: "bot Grace" });
    expect(rooms.stats()).toMatchObject({ players: 1, bots: 3 });
    expect(saved.map((r) => r.name)).toEqual(["Bob"]);
  });

  test("a full arena gives a bot's slot to each person at once, so 20 people still fit and no tick sees more than 20", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup(spy(saved), FILL_TARGET);
    const a = client();
    rooms.join("p0", "tabs", INFO, a.send);
    tick();
    const room = rooms.room(1)!;
    for (let i = 1; i < MAX_PLAYERS_PER_ARENA; i++) {
      expect(rooms.join(`p${i}`, "tabs", INFO, client().send).room).toBe(1);
      expect(room.state.players.length).toBeLessThanOrEqual(MAX_PLAYERS_PER_ARENA);
      // Past 17 people each join evicts a bot in the middle of its life, unsaved.
      expect(room.botCount).toBe(Math.min(3, MAX_PLAYERS_PER_ARENA - (i + 1)));
    }
    expect(leaves(a.got).length).toBe(3);
    tick();
    expect(snapshots(a.got).at(-1)!.p.length).toBe(MAX_PLAYERS_PER_ARENA);
    expect(rooms.stats()).toMatchObject({ players: 20, bots: 0 });
    expect(rooms.join("p20", "tabs", INFO, client().send).room).toBe(2);
    expect(saved).toEqual([]);
  });

  test("the last person out closes the arena, bots and all, saving only the person's life", () => {
    const saved: LifeRecord[] = [];
    const { rooms, timers, tick } = setup(spy(saved), FILL_TARGET);
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    tick(20);
    expect(rooms.stats().bots).toBe(3);
    rooms.leave(j.room, j.entity);
    expect(rooms.room(j.room)).toBeUndefined();
    expect(timers.size).toBe(0);
    expect(rooms.stats()).toMatchObject({ arenas: [], players: 0, bots: 0 });
    expect(saved.map((r) => r.name)).toEqual(["Ada"]);
  });

  test("tick budget: 20 fill bots in one arena for 60 s of play", () => {
    const log = createTickLog();
    const room = new Room(1, arenaSeed(1), 0, log);
    for (let i = 0; i < MAX_PLAYERS_PER_ARENA; i++) room.addBot();
    const ticks = 60_000 / TICK_MS;
    for (let i = 1; i <= ticks; i++) room.tick(i * TICK_MS);
    const { p50, p95 } = log.percentiles(ticks * TICK_MS);
    console.log(`20 fill bots, ${ticks} ticks, ${room.state.bugs.length} bugs at the end: tick p50 ${p50!.toFixed(3)} ms, p95 ${p95!.toFixed(3)} ms`);
    expect(room.botCount).toBe(MAX_PLAYERS_PER_ARENA);
    expect(room.state.players.length).toBe(MAX_PLAYERS_PER_ARENA);
    // The PRD's budget, loosely: `check` must stay green on a loaded machine.
    expect(p95!).toBeLessThan(10);
  });
});

describe("the stream board's live read (#74)", () => {
  test("no arenas: nobody playing", () => {
    expect(setup().rooms.live()).toEqual({ playing: 0, arenas: [] });
  });

  test("one person topped up with fill bots counts 1: bots never count; the wave moves with the arena's clock", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    rooms.join("Ada", "tabs", INFO, client().send);
    tick();
    expect(rooms.stats().bots).toBe(FILL_TARGET - 1);
    expect(rooms.live()).toEqual({ playing: 1, arenas: [{ id: 1, players: 1, wave: 1 }] });
    tick(Math.round((WAVE_S * 1000) / TICK_MS));
    expect(rooms.live()).toEqual({ playing: 1, arenas: [{ id: 1, players: 1, wave: 2 }] });
  });

  test("21 people make two arenas, by id; an arena whose last person leaves is gone", () => {
    const { rooms } = setup();
    const joined = Array.from({ length: MAX_PLAYERS_PER_ARENA + 1 }, (_, i) => rooms.join(`P${i}`, "tabs", INFO, client().send));
    expect(rooms.live()).toEqual({
      playing: MAX_PLAYERS_PER_ARENA + 1,
      arenas: [
        { id: 1, players: MAX_PLAYERS_PER_ARENA, wave: 1 },
        { id: 2, players: 1, wave: 1 },
      ],
    });
    const last = joined[MAX_PLAYERS_PER_ARENA]!;
    rooms.leave(last.room, last.entity);
    expect(rooms.live()).toEqual({ playing: MAX_PLAYERS_PER_ARENA, arenas: [{ id: 1, players: MAX_PLAYERS_PER_ARENA, wave: 1 }] });
  });
});
