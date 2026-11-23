import { describe, expect, test } from "bun:test";
import {
  DASH_COOLDOWN_TICKS,
  DASH_SPAWN_LOCK_TICKS,
  DASH_TICKS,
  DEMO_BOTS,
  DEMO_WARM_TICKS,
  FILL_TARGET,
  INPUT_BUFFER,
  INPUT_STALE_TICKS,
  MAX_PLAYERS_PER_ARENA,
  MAX_WATCHERS,
  MINIMAP_CELL,
  OUT_IDLE_TICKS,
  PROTOCOL_VERSION,
  TICK_MS,
  WAVE_S,
} from "../../shared/arena/constants";
import { parseServerMessage, type ServerMessage, type Snapshot, type WireSnapshot } from "../../shared/arena/protocol";
import { createSnapshotReader } from "../../shared/arena/view";
import { endLife, type Input } from "../../shared/arena/sim";
import { DOWN_TICKS, HITS_PER_LIFE, REVIVE_POINTS, REVIVE_TICKS } from "../../shared/arena/constants";
import { QUEEN_EVERY_WAVES } from "../../shared/arena/bugs/queen";
import { QUEEN_MARKER_TICKS, QUEEN_REWARD_EACH, QUEEN_REWARD_POOL } from "../../shared/arena/queen";
import { placeBug } from "../../shared/arena/testkit";
import { isBotName } from "../rules";
import { Room, meOf, type LifeRecord } from "./room";
import { Rooms, arenaSeed } from "./rooms";
import { createTickLog } from "./ticks";

const INFO = { playerKey: "0".repeat(32), touch: false };

/**
 * Rooms on a fake clock and fake timers: `tick()` fires every running timer once. No fill bots
 * unless `fillTo` is given, so the counts below are people only. `startTick` is each new arena's
 * first tick (BUG_SWARM_START_WAVE's, serve.ts).
 */
function setup(saveLife?: (r: LifeRecord) => void, fillTo = 0, startTick = 0) {
  let now = 1_000_000;
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const rooms = new Rooms({
    now: () => now,
    clock: () => 0,
    buildId: "test-build",
    saveLife,
    fillTo,
    startTick,
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

/**
 * A socket's side: every message, snapshots decoded as a browser decodes them (view.ts), and the
 * raw wire snapshots. `drop` makes the next sends fail, as a socket Bun drops a frame on.
 */
function client() {
  const got: ServerMessage[] = [];
  const wire: WireSnapshot[] = [];
  const read = createSnapshotReader();
  const c = {
    got,
    wire,
    drop: false,
    send: (m: string) => {
      if (c.drop) return false;
      const w = parseServerMessage(m)!;
      if (w.t === "snapshot") wire.push(w);
      const decoded = read(w);
      if (decoded) got.push(decoded);
      return true;
    },
  };
  return c;
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

  test("full once maxPeople play across every arena, and free again after one leaves (#104)", () => {
    const rooms = new Rooms({ startTimer: () => () => {}, fillTo: 0, maxPeople: 3 });
    expect(new Rooms({ startTimer: () => () => {} }).full).toBe(false);
    const a = rooms.join("a", "tabs", INFO, client().send);
    rooms.join("b", "tabs", INFO, client().send);
    expect(rooms.full).toBe(false);
    rooms.join("c", "spaces", INFO, client().send);
    expect(rooms.full).toBe(true);
    // A watcher is not a person: it opens no arena and changes nothing.
    rooms.watch(client().send);
    expect(rooms.stats().arenas.length).toBe(1);
    rooms.leave(a.room, a.entity);
    expect(rooms.full).toBe(false);
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
    expect(sb.p.map((p) => p[0])).toEqual([ja.entity, jb.entity]);
    const ada = rooms.room(ja.room)!.state.players[0]!;
    // Ada's own row is exact, with her velocity (vx 120 after one step of mx = 1); Bob sees her to 0.1, with none (v11).
    expect(sa.p[0]!.slice(1, 5)).toEqual([Math.round(ada.x * 100) / 100, Math.round(ada.y * 100) / 100, 120, 0]);
    expect(sb.p[0]!.slice(1, 5)).toEqual([Math.round(ada.x * 10) / 10, Math.round(ada.y * 10) / 10, 0, 0]);
    expect(sa.me).toMatchObject({ x: sa.p[0]![1], vx: 120 });
  });

  test("a snapshot the socket dropped makes that member's next one a keyframe; the others carry on with deltas", () => {
    const { rooms, tick } = setup();
    const a = client();
    const b = client();
    rooms.join("Ada", "tabs", INFO, a.send);
    rooms.join("Bob", "spaces", INFO, b.send);
    tick(3);
    a.drop = true;
    tick();
    a.drop = false;
    tick();
    expect(a.wire.map((w) => w.key === 1)).toEqual([true, false, false, true]);
    expect(b.wire.map((w) => w.key === 1)).toEqual([true, false, false, false, false]);
    // Ada decodes every snapshot she got: the keyframe resynced her.
    expect(snapshots(a.got).map((s) => s.tick)).toEqual([1, 2, 3, 5]);
  });

  test("a bug far from a player is not in their snapshot, but is on their minimap; a player near it gets it", () => {
    const { rooms, tick } = setup();
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", INFO, a.send);
    const jb = rooms.join("Bob", "spaces", INFO, b.send);
    const state = rooms.room(ja.room)!.state;
    const [ada, bob] = [state.players[0]!, state.players[1]!];
    [ada.x, ada.y, bob.x, bob.y] = [500, 500, 1900, 1900];
    const bug = placeBug(state, 1950, 1950);
    tick();
    const sa = snapshots(a.got).at(-1)!;
    const sb = snapshots(b.got).at(-1)!;
    expect(sa.b.map((r) => r[0])).not.toContain(bug.id);
    expect(sa.m).toEqual([Math.round(bug.x / MINIMAP_CELL), Math.round(bug.y / MINIMAP_CELL)]);
    expect(sb.b.map((r) => r[0])).toContain(bug.id);
    expect(sa.p.map((p) => p[0])).toEqual([ja.entity, jb.entity]);
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
    p.effect.fill(0); // no first-life shield (#90)
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
      p.effect.fill(0);
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
    pa.effect.fill(0); // and without the first-life shield (#90)
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

  test("a hive queen (#85): every member sees her marker and health in `q`, then her kill as a `queen` event with every reward, saved on the life", () => {
    const saved: LifeRecord[] = [];
    const { rooms, tick } = setup((r) => saved.push(r));
    const a = client();
    const b = client();
    const ja = rooms.join("Ada", "tabs", INFO, a.send);
    rooms.join("Bob", "spaces", { playerKey: "b".repeat(32), touch: false }, b.send);
    const room = rooms.room(ja.room)!;
    const st = room.state;
    const quiet = () => {
      for (const p of st.players) {
        p.budget = 0;
        p.invulnTicks = 1000;
      }
    };
    quiet();
    tick();
    st.bugs.length = 0;
    // The tick before wave QUEEN_EVERY_WAVES starts: the next one shows her marker.
    st.tick = Math.round(((QUEEN_EVERY_WAVES - 1) * WAVE_S) / (TICK_MS / 1000));
    quiet();
    tick();
    expect(snapshots(a.got).at(-1)!.q).toEqual([0, st.queen.x, st.queen.y, QUEEN_MARKER_TICKS]);
    for (let i = 0; i < QUEEN_MARKER_TICKS; i++) {
      quiet();
      tick();
    }
    const q = st.bugs.find((x) => x.kind === "queen")!;
    const r1 = (v: number) => Math.round(v);
    expect(snapshots(b.got).at(-1)!.q).toEqual([1, q.id, r1(q.x), r1(q.y), q.hp, q.hp]);
    // Ada fires a shot at her last hit point.
    const pa = st.players.find((p) => p.id === ja.entity)!;
    q.hp = 1;
    pa.x = q.x - 120;
    pa.y = q.y;
    pa.protectTicks = 0;
    for (let i = 0; i < 6 && st.queen.stage === 2; i++) {
      rooms.input(ja.room, ja.entity, { seq: 100 + i, mx: 0, my: 0, aim: 0, fire: i === 0, dash: false });
      quiet();
      tick();
    }
    expect(st.queen.stage).toBe(0);
    const reward = QUEEN_REWARD_EACH + QUEEN_REWARD_POOL;
    for (const c of [a, b]) {
      expect(c.got.filter((m) => m.t === "event" && m.kind === "queen")).toEqual([{ t: "event", kind: "queen", id: ja.entity, paid: [[ja.entity, reward]] }]);
      expect(snapshots(c.got).at(-1)!.q).toEqual([]);
    }
    rooms.leave(ja.room, ja.entity);
    expect(saved).toMatchObject([{ playerKey: INFO.playerKey, score: reward }]);
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
  p.effect.fill(0);
  p.effect[1] = 37;
  const me = { sc: 0, ki: 0, st: 0, mu: 0, he: 0, lk: 0 as 0 | 1, hl: 0, al: 0 as 0 | 1, dk: 0, dc: 0, dn: 0 as 0 | 1, fx: [] as number[], x: 0, y: 0, vx: 0, vy: 0 };
  const fx = me.fx;
  expect(meOf(p, me)).toEqual({ sc: 125, ki: 11, st: 6, mu: 1.5, he: 0.42, lk: 1, hl: 2, al: 1, dk: 2, dc: 27, dn: 0, fx: [0, 37, 0, 0], x: p.x, y: p.y, vx: p.vx, vy: p.vy });
  // The effects are copied into the same array every snapshot.
  expect(me.fx).toBe(fx);
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
    grace.effect.fill(0);
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
    expect(rooms.live()).toEqual({ playing: 1, arenas: [{ id: 1, players: 1, wave: 1, queen: null }] });
    tick(Math.round((WAVE_S * 1000) / TICK_MS));
    expect(rooms.live()).toEqual({ playing: 1, arenas: [{ id: 1, players: 1, wave: 2, queen: null }] });
  });

  test("21 people make two arenas, by id; an arena whose last person leaves is gone", () => {
    const { rooms } = setup();
    const joined = Array.from({ length: MAX_PLAYERS_PER_ARENA + 1 }, (_, i) => rooms.join(`P${i}`, "tabs", INFO, client().send));
    expect(rooms.live()).toEqual({
      playing: MAX_PLAYERS_PER_ARENA + 1,
      arenas: [
        { id: 1, players: MAX_PLAYERS_PER_ARENA, wave: 1, queen: null },
        { id: 2, players: 1, wave: 1, queen: null },
      ],
    });
    const last = joined[MAX_PLAYERS_PER_ARENA]!;
    rooms.leave(last.room, last.entity);
    expect(rooms.live()).toEqual({ playing: MAX_PLAYERS_PER_ARENA, arenas: [{ id: 1, players: MAX_PLAYERS_PER_ARENA, wave: 1, queen: null }] });
  });

  test("an arena's hive queen: her health in whole percent once she arrives (#102)", () => {
    const lead = Math.round(10_000 / TICK_MS);
    const queenWave = Math.round(((QUEEN_EVERY_WAVES - 1) * WAVE_S * 1000) / TICK_MS);
    const { rooms, tick } = setup(undefined, 0, queenWave - lead);
    rooms.join("Ada", "tabs", INFO, client().send);
    // Nothing shoots her (no fill bots) and nothing ends Ada's life, so she arrives untouched.
    rooms.room(1)!.state.players[0]!.invulnTicks = 1e9;
    tick(lead + 1 + QUEEN_MARKER_TICKS);
    expect(rooms.live().arenas).toEqual([{ id: 1, players: 1, wave: QUEEN_EVERY_WAVES, queen: 100 }]);
  });
});

describe("watchers (#79, the start screen)", () => {
  /** A socket's send that keeps the raw strings too, to compare them. */
  function rawClient() {
    const raw: string[] = [];
    const got: ServerMessage[] = [];
    const read = createSnapshotReader();
    return {
      raw,
      got,
      send: (m: string) => {
        raw.push(m);
        const decoded = read(parseServerMessage(m)!);
        if (decoded) got.push(decoded);
        return true;
      },
    };
  }

  test("on an empty server the first watcher opens a demo arena of DEMO_BOTS bots, already DEMO_WARM_S in and fighting, off the board, that closes with its last watcher", () => {
    const { rooms, timers, tick } = setup(undefined, FILL_TARGET);
    const w = rawClient();
    const watching = rooms.watch(w.send)!;
    // Warmed up before the watcher came: its bots are in the welcome's roster, bugs are out.
    expect(watching.welcome).toMatchObject({ t: "welcome", you: 0, arena: 1, tick: DEMO_WARM_TICKS });
    expect(watching.welcome.roster.length).toBe(DEMO_BOTS);
    expect(rooms.room(1)!.state.bugs.length).toBeGreaterThan(10);
    // None of the warm-up's ticks are in the stats.
    expect(rooms.stats().tick.p50).toBeNull();
    tick();
    expect(w.got.filter((m) => m.t === "event" && m.kind === "join")).toEqual([]);
    const snap = snapshots(w.got).at(-1)!;
    expect(snap.ack).toBe(0);
    expect(snap.me).toMatchObject({ sc: 0, al: 0, hl: 0 });
    expect(snap.p.length).toBe(DEMO_BOTS);
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 1, players: 0, bots: DEMO_BOTS, watchers: 1 }], players: 0, watchers: 1 });
    expect(rooms.live()).toEqual({ playing: 0, arenas: [] });
    rooms.unwatch(watching.watcher);
    expect(rooms.stats()).toMatchObject({ arenas: [], watchers: 0 });
    // The arena's tick timer and the rehome sweep are both stopped.
    expect(timers.size).toBe(0);
  });

  test("every watcher of an arena gets the identical snapshot string each tick; events reach them, their coming and going reaches nobody", () => {
    const { rooms, tick } = setup();
    const a = client();
    rooms.join("Ada", "tabs", INFO, a.send);
    const w1 = rawClient();
    const w2 = rawClient();
    rooms.watch(w1.send);
    const second = rooms.watch(w2.send)!;
    expect(second.welcome.roster).toEqual([{ id: 1, name: "Ada", team: "tabs" }]);
    rooms.join("Bob", "spaces", INFO, client().send);
    tick(3);
    expect(w1.raw.length).toBeGreaterThan(0);
    expect(w1.raw).toEqual(w2.raw);
    expect(w1.got.map((m) => (m.t === "event" ? m.kind : m.t))).toEqual(["join", "snapshot", "snapshot", "snapshot"]);
    rooms.unwatch(second.watcher);
    tick();
    // Ada saw Bob join and her snapshots, never a watcher.
    expect(a.got.filter((m) => m.t === "event").map((m) => (m as { name?: string }).name)).toEqual(["Bob"]);
    expect(rooms.stats()).toMatchObject({ players: 2, watchers: 1, arenas: [{ id: 1, players: 2, watchers: 1 }] });
  });

  test("a watcher arriving mid-stream gets a keyframe while the others get the shared delta; both decode the same arena (#89)", () => {
    const { rooms, tick } = setup();
    rooms.join("Ada", "tabs", INFO, client().send);
    const w1 = rawClient();
    rooms.watch(w1.send);
    tick(3);
    const w2 = rawClient();
    rooms.watch(w2.send);
    tick();
    const keyOf = (raw: string) => (JSON.parse(raw) as WireSnapshot).key === 1;
    expect(w1.raw.filter((r) => r.startsWith('{"t":"snapshot"')).map(keyOf)).toEqual([true, false, false, false]);
    expect(w2.raw.map(keyOf)).toEqual([true]);
    expect(snapshots(w2.got).at(-1)).toEqual(snapshots(w1.got).at(-1)!);
    tick();
    // From then on they share one stream.
    expect(w2.raw.at(-1)).toBe(w1.raw.at(-1)!);
  });

  test("stream scale (#119): 300 watchers share one encoded delta per tick; a dropped send keyframes only that watcher; the cap is MAX_WATCHERS", () => {
    const { rooms, tick } = setup();
    rooms.join("Ada", "tabs", INFO, client().send);
    const ws = Array.from({ length: 300 }, () => {
      const w = { raw: [] as string[], drop: false, send: (m: string) => (w.raw.push(m), !w.drop) };
      return w;
    });
    for (const w of ws) expect(rooms.watch(w.send)).not.toBeNull();
    const isSnap = (m: string) => m.startsWith('{"t":"snapshot"');
    const keyOf = (m: string) => (JSON.parse(m) as WireSnapshot).key === 1;
    tick();
    // Everyone new: one shared keyframe.
    expect(ws.every((w) => w.raw.filter(isSnap).length === 1 && keyOf(w.raw.at(-1)!))).toBe(true);
    tick();
    const delta = ws[0]!.raw.at(-1)!;
    expect(keyOf(delta)).toBe(false);
    expect(ws.every((w) => w.raw.at(-1) === delta)).toBe(true);
    // One watcher's send is dropped; the next tick only it gets a keyframe.
    ws[7]!.drop = true;
    tick();
    ws[7]!.drop = false;
    tick();
    const shared = ws[0]!.raw.at(-1)!;
    expect(keyOf(shared)).toBe(false);
    expect(keyOf(ws[7]!.raw.at(-1)!)).toBe(true);
    expect(ws.filter((w) => w.raw.at(-1) !== shared)).toEqual([ws[7]!]);
    // Room up to the cap, and not one more.
    expect(MAX_WATCHERS).toBeGreaterThanOrEqual(300);
    for (let i = 300; i < MAX_WATCHERS; i++) expect(rooms.watch(client().send)).not.toBeNull();
    expect(rooms.stats().watchers).toBe(MAX_WATCHERS);
    expect(rooms.watch(client().send)).toBeNull();
  });

  test("a watch lands in the arena with the most people; past the cap it is refused until one leaves", () => {
    const rooms = new Rooms({ now: () => 0, clock: () => 0, fillTo: 0, maxWatchers: 2, startTimer: () => () => {} });
    // A full arena 1 and an arena 2 with one person.
    for (let i = 0; i < MAX_PLAYERS_PER_ARENA + 1; i++) rooms.join(`p${i}`, "tabs", INFO, client().send);
    expect(rooms.stats().arenas.map((a) => a.players)).toEqual([MAX_PLAYERS_PER_ARENA, 1]);
    const first = rooms.watch(client().send)!;
    expect(first.welcome.arena).toBe(1);
    expect(rooms.watch(client().send)!.welcome.arena).toBe(1);
    expect(rooms.watch(client().send)).toBeNull();
    rooms.unwatch(first.watcher);
    expect(rooms.watch(client().send)).not.toBeNull();
  });

  test("a join never lands in a watched arena with no people; rehome then moves its watchers to the people, with a welcome, and the demo closes", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    const w = rawClient();
    rooms.watch(w.send);
    tick();
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    expect(j.room).toBe(2);
    expect(rooms.room(1)!.size).toBe(0);
    // The fake timers fire the sweep with the arenas' ticks.
    tick();
    const welcomes = w.got.filter((m) => m.t === "welcome");
    expect(welcomes).toEqual([expect.objectContaining({ you: 0, arena: 2 })]);
    expect(rooms.room(1)).toBeUndefined();
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 2, players: 1, watchers: 1 }], watchers: 1 });
    // After the welcome, the watcher's snapshots are arena 2's: Ada is in them.
    tick();
    expect(snapshots(w.got).at(-1)!.p.some((p) => p[0] === j.entity)).toBe(true);
  });

  test("the last person leaving a watched arena keeps it open with the demo bots, off the board; a new person opens another", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    const j = rooms.join("Ada", "tabs", INFO, client().send);
    tick();
    rooms.watch(client().send);
    rooms.leave(j.room, j.entity);
    tick(40);
    expect(rooms.stats()).toMatchObject({ arenas: [{ id: 1, players: 0, bots: DEMO_BOTS, watchers: 1 }] });
    expect(rooms.live()).toEqual({ playing: 0, arenas: [] });
    expect(rooms.join("Bob", "tabs", INFO, client().send).room).toBe(2);
  });

  test("endAll forgets the watchers and stops the sweep", () => {
    const { rooms, timers } = setup();
    rooms.watch(client().send);
    rooms.endAll();
    expect(rooms.stats()).toMatchObject({ arenas: [], watchers: 0 });
    expect(timers.size).toBe(0);
  });
});

describe("active people (#117): out for OUT_IDLE_S or hidden stops counting", () => {
  /** Ends `id`'s life now, as a bleed-out would (the simulation's endLife). */
  const out = (rooms: Rooms, room: number, id: number) => endLife(rooms.room(room)!.state, rooms.room(room)!.state.players.find((p) => p.id === id)!);
  /** Keeps `id` in their life whatever comes. */
  const keep = (rooms: Rooms, room: number, id: number) => (rooms.room(room)!.state.players.find((p) => p.id === id)!.invulnTicks = 1e9);
  const press = (seq: number): Input => ({ seq, mx: 0, my: 0, aim: 0, fire: false, dash: true });

  test("an arena whose 4 people are out for OUT_IDLE_S is topped up with fill bots again; playing again counts again in place", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    const a = client();
    const js = [rooms.join("Ada", "tabs", INFO, a.send), ...["Bob", "Cy", "Di"].map((n) => rooms.join(n, "spaces", INFO, client().send))];
    const room = rooms.room(1)!;
    tick();
    expect([room.people, room.botCount]).toEqual([4, 0]);
    for (const j of js) out(rooms, 1, j.entity);
    tick(OUT_IDLE_TICKS - 1);
    expect([room.people, room.botCount]).toEqual([4, 0]);
    expect(rooms.live().playing).toBe(4);
    tick();
    // OUT_IDLE_S out: nobody counts, and the next tick tops the arena up to the fill target.
    expect([room.people, room.size, room.botCount]).toEqual([0, 4, 0]);
    expect(rooms.live()).toEqual({ playing: 0, arenas: [] });
    tick();
    expect([room.people, room.size, room.botCount]).toEqual([0, 4, FILL_TARGET]);
    // Ada presses play: the same robot respawns (no welcome), and counts at once.
    rooms.input(1, js[0]!.entity, press(1));
    tick();
    expect(room.state.players.find((p) => p.id === js[0]!.entity)!.alive).toBe(true);
    expect(room.people).toBe(1);
    expect(a.got.filter((m) => m.t === "welcome")).toEqual([]);
    expect(rooms.live().playing).toBe(1);
  });

  test("a new joiner lands in the arena with active players, not the fuller one whose people are all out", () => {
    const { rooms, tick } = setup();
    const js = ["A", "B", "C", "D"].map((n) => rooms.join(`P${n}`, "tabs", INFO, client().send));
    for (const j of js) out(rooms, 1, j.entity);
    tick(OUT_IDLE_TICKS);
    // Arena 1 counts nobody: the first joiner opens arena 2 rather than play alone in arena 1.
    const bob = rooms.join("Bob", "tabs", INFO, client().send);
    expect(bob.room).toBe(2);
    keep(rooms, 2, bob.entity);
    tick();
    // Arena 1 still has 4 members, arena 2 one: the next joiner goes where someone plays.
    expect([rooms.room(1)!.size, rooms.room(2)!.size]).toEqual([4, 1]);
    expect(rooms.join("Cy", "tabs", INFO, client().send).room).toBe(2);
  });

  test("the board counts only active people: a hidden tab and a person out for OUT_IDLE_S are left out, and an arena with none is gone", () => {
    const { rooms, tick } = setup();
    const [hid, gone, here] = ["Hid", "Gone", "Here"].map((n) => rooms.join(n, "tabs", INFO, client().send));
    keep(rooms, 1, hid!.entity);
    keep(rooms, 1, here!.entity);
    out(rooms, 1, gone!.entity);
    rooms.visibility(1, hid!.entity, true);
    tick(OUT_IDLE_TICKS);
    expect(rooms.live()).toMatchObject({ playing: 1, arenas: [{ id: 1, players: 1 }] });
    // The load numbers still count every member.
    expect(rooms.stats().players).toBe(3);
    rooms.visibility(1, here!.entity, true);
    expect(rooms.live()).toEqual({ playing: 0, arenas: [] });
    // Shown again: counted again, at once.
    rooms.visibility(1, hid!.entity, false);
    rooms.visibility(1, here!.entity, false);
    expect(rooms.live().playing).toBe(2);
  });

  test("a full arena frees the slot of the member out longest; their play press joins them again there, or in another arena once it is full of people, never refused", () => {
    const { rooms, tick } = setup();
    const cs = Array.from({ length: MAX_PLAYERS_PER_ARENA }, () => client());
    const js = cs.map((c, i) => rooms.join(`p${i}`, "tabs", INFO, c.send));
    const room = rooms.room(1)!;
    for (const j of js.slice(2)) keep(rooms, 1, j.entity);
    out(rooms, 1, js[0]!.entity);
    tick();
    out(rooms, 1, js[1]!.entity);
    tick(OUT_IDLE_TICKS);
    expect([room.people, room.size, room.state.players.length]).toEqual([18, 20, 20]);
    // A newcomer takes p0's slot (out longest): everyone, p0 included, is told p0 left.
    const nc = client();
    const nj = rooms.join("New", "spaces", INFO, nc.send);
    keep(rooms, 1, nj.entity);
    expect(nj.room).toBe(1);
    expect([room.people, room.size, room.awayCount, room.state.players.length]).toEqual([19, 20, 1, 20]);
    expect(cs[0]!.got.at(-2)).toEqual({ t: "event", kind: "leave", id: js[0]!.entity });
    expect(cs[2]!.got.some((m) => m.t === "event" && m.kind === "leave" && m.id === js[0]!.entity)).toBe(true);
    // p0's socket now watches the arena: a keyframe with no robot of its own.
    const before = cs[0]!.got.length;
    tick();
    const watched = snapshots(cs[0]!.got.slice(before));
    expect(watched.length).toBe(1);
    expect(watched[0]!.p.length).toBe(MAX_PLAYERS_PER_ARENA);
    expect(watched[0]!.p.some((r) => r[0] === js[0]!.entity)).toBe(false);
    // Anything but a play press from an away socket does nothing.
    expect(rooms.input(1, js[0]!.entity, input(1))).toBeNull();
    // p0 presses play: back in arena 1 (p1, out longest now, gives up the slot), welcome first.
    const mark = cs[0]!.got.length;
    const back = rooms.input(1, js[0]!.entity, press(2))!;
    expect(back.room).toBe(1);
    expect(back.entity).not.toBe(js[0]!.entity);
    expect(cs[0]!.got.slice(mark)[0]).toEqual(back.welcome);
    expect(back.welcome).toMatchObject({ t: "welcome", you: back.entity, arena: 1 });
    keep(rooms, 1, back.entity);
    expect([room.people, room.size, room.awayCount]).toEqual([20, 20, 1]);
    // p1 presses play: arena 1 is full of people, so p1 goes to a new arena, with a welcome and no error.
    const mark1 = cs[1]!.got.length;
    const moved = rooms.input(1, js[1]!.entity, press(1))!;
    expect(moved.room).toBe(2);
    expect(cs[1]!.got.slice(mark1)).toEqual([moved.welcome]);
    expect(cs[1]!.got.some((m) => m.t === "error")).toBe(false);
    expect([room.awayCount, rooms.room(2)!.size]).toEqual([0, 1]);
    // Leaving with the new ids leaves the new arenas; an old id is nobody.
    rooms.leave(moved.room, moved.entity);
    expect(rooms.room(2)).toBeUndefined();
    rooms.leave(1, js[1]!.entity);
    expect(room.size).toBe(20);
  });

  test("hidden and out frees its slot at once; hidden in a life does not count but keeps its robot", () => {
    const { rooms, tick } = setup();
    const js = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, i) => rooms.join(`p${i}`, "tabs", INFO, client().send));
    for (const j of js) keep(rooms, 1, j.entity);
    const room = rooms.room(1)!;
    out(rooms, 1, js[1]!.entity);
    rooms.visibility(1, js[0]!.entity, true);
    rooms.visibility(1, js[1]!.entity, true);
    tick();
    expect(room.people).toBe(18);
    // p1 (hidden, out a tick) gives up its slot; p0 (hidden, in a life) does not.
    expect(rooms.join("New", "tabs", INFO, client().send).room).toBe(1);
    expect([room.awayCount, room.state.players.some((p) => p.id === js[0]!.entity)]).toEqual([1, true]);
    expect(rooms.join("Next", "tabs", INFO, client().send).room).toBe(2);
  });

  test("an arena that peaked at 20 with 19 now out for OUT_IDLE_S still tops its last player up with fill bots; a moved-away member's press gets them back into it", () => {
    const { rooms, tick } = setup(undefined, FILL_TARGET);
    const cs = Array.from({ length: MAX_PLAYERS_PER_ARENA }, () => client());
    const js = cs.map((c, i) => rooms.join(`p${i}`, "tabs", INFO, c.send));
    const room = rooms.room(1)!;
    keep(rooms, 1, js[0]!.entity);
    for (const j of js.slice(1)) out(rooms, 1, j.entity);
    tick(OUT_IDLE_TICKS);
    // The out members' slots go to bots: the last player is no longer alone.
    tick();
    expect([room.people, room.botCount, room.awayCount, room.state.players.length]).toEqual([1, FILL_TARGET - 1, FILL_TARGET - 1, MAX_PLAYERS_PER_ARENA]);
    const gone = js.find((j) => room.isAway(j.entity))!;
    const back = rooms.input(1, gone.entity, press(1))!;
    expect(back.room).toBe(1);
    expect(room.people).toBe(2);
    expect(room.state.players.length).toBeLessThanOrEqual(MAX_PLAYERS_PER_ARENA);
  });

  test("a moved-away member keeps their arena open after everyone else leaves, and their press gets them back into it", () => {
    const { rooms, tick } = setup();
    const js = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, i) => rooms.join(`p${i}`, "tabs", INFO, client().send));
    for (const j of js.slice(1)) keep(rooms, 1, j.entity);
    out(rooms, 1, js[0]!.entity);
    tick(OUT_IDLE_TICKS);
    const n = rooms.join("New", "tabs", INFO, client().send);
    expect(rooms.room(1)!.isAway(js[0]!.entity)).toBe(true);
    for (const j of [...js.slice(1), n]) rooms.leave(1, j.entity);
    expect(rooms.room(1)).toBeDefined();
    const back = rooms.input(1, js[0]!.entity, press(1))!;
    expect(back.room).toBe(1);
    rooms.leave(back.room, back.entity);
    expect(rooms.room(1)).toBeUndefined();
  });

  test("a moved-away member goes back to their own arena when it has room, even with a busier arena open", () => {
    const { rooms, tick } = setup();
    const js = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, i) => rooms.join(`p${i}`, "tabs", INFO, client().send));
    for (const j of js.slice(1)) keep(rooms, 1, j.entity);
    out(rooms, 1, js[0]!.entity);
    tick(OUT_IDLE_TICKS);
    const n = rooms.join("New", "tabs", INFO, client().send);
    keep(rooms, 1, n.entity);
    expect(rooms.room(1)!.isAway(js[0]!.entity)).toBe(true);
    // Arena 1 is full of people: 10 more open arena 2. Then 15 leave arena 1, which keeps 5.
    for (let i = 0; i < 10; i++) {
      const j = rooms.join(`q${i}`, "spaces", INFO, client().send);
      expect(j.room).toBe(2);
      keep(rooms, 2, j.entity);
    }
    for (const j of js.slice(1, 16)) rooms.leave(1, j.entity);
    expect([rooms.room(1)!.people, rooms.room(2)!.people]).toEqual([5, 10]);
    expect(rooms.input(1, js[0]!.entity, press(1))!.room).toBe(1);
  });

  test("an away socket closing leaves nothing behind, and the arena closes once nobody is left in it", () => {
    const { rooms, timers, tick } = setup();
    const js = Array.from({ length: MAX_PLAYERS_PER_ARENA }, (_, i) => rooms.join(`p${i}`, "tabs", INFO, client().send));
    for (const j of js.slice(0, -1)) out(rooms, 1, j.entity);
    keep(rooms, 1, js.at(-1)!.entity);
    tick(OUT_IDLE_TICKS);
    const n = rooms.join("New", "tabs", INFO, client().send);
    expect(rooms.room(1)!.awayCount).toBe(1);
    for (const j of [...js, n]) rooms.leave(1, j.entity);
    expect(rooms.room(1)).toBeUndefined();
    expect(timers.size).toBe(0);
  });
});
