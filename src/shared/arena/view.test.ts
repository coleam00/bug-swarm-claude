// Snapshots at stream scale (#89): a stepped arena, encoded for one player (culled) and for the
// watchers (whole), decoded through a reader, must equal what the arena holds, culled and quantized
// straight from the simulation's state, on every tick. Plus keyframe cadence, resync after a lost
// delta, the minimap's far bugs, and the size of a full view.
import { describe, expect, test } from "bun:test";
import {
  BUG_KINDS,
  DT,
  DOWN_TICKS,
  KEYFRAME_TICKS,
  MAX_PLAYERS_PER_ARENA,
  MINIMAP_CELL,
  PICKUP_IDS,
  REVIVE_TICKS,
  SHOT_RANGE,
  PROTOCOL_VERSION,
  TICK_MS,
  WAVE_S,
  WORLD_H,
  WORLD_W,
  type BugKind,
} from "./constants";
import { QUEEN_EVERY_WAVES } from "./bugs/queen";
import { createFillMemory, createObservation, fillBot, observe, type PolicyInput } from "./policies";
import { QUEEN_MARKER_TICKS } from "./queen";
import { WELCOME, parseServerMessage, type Snapshot, type SnapshotMe, type WireSnapshot } from "./protocol";
import { createRng } from "./rng";
import { joinPlayer, leavePlayer, stepArena, wave, type ArenaState, type Player } from "./sim";
import { arenaWith, placeBug, placePickup } from "./testkit";
import {
  VIEW_HALF,
  applySnapshot,
  createArenaFrame,
  createSnapshotReader,
  createViewMirror,
  createViewState,
  encodeView,
  keyframeOf,
  quantizeArena,
  viewBoxOf,
  type ViewBox,
} from "./view";

// `|| 0`: JSON writes -0 as 0.
const q1 = (v: number) => Math.round(v * 10) / 10 || 0;
const q2 = (v: number) => Math.round(v * 100) / 100 || 0;
const q3 = (v: number) => Math.round(v * 1000) / 1000 || 0;

function meOf(p: Player | undefined): SnapshotMe {
  if (!p) return { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0, fx: PICKUP_IDS.map(() => 0), x: 0, y: 0, vx: 0, vy: 0 };
  return { sc: p.score, ki: p.kills, st: p.streak, mu: 1, he: p.heat, lk: p.lockTicks > 0 ? 1 : 0, hl: 0, al: p.alive ? 1 : 0, dk: p.dashTicks, dc: p.dashCooldown, dn: p.down ? 1 : 0, fx: p.effect.slice(), x: p.x, y: p.y, vx: p.vx, vy: p.vy };
}

const inBox = (box: ViewBox | null, x: number, y: number, pad = 0) => !box || (Math.abs(x - box.cx) <= box.half + pad && Math.abs(y - box.cy) <= box.half + pad);
const byId = <T extends number[]>(rows: T[]) => [...rows].sort((a, b) => a[0]! - b[0]!);

/**
 * What `you` (0: a watcher, no box) should decode at this tick, built from the simulation's own
 * state. `origins` holds where each shot in flight started. Rows sorted by id where the wire's
 * order is the mirror's, not the arena's.
 */
function expected(a: ArenaState, box: ViewBox | null, you: number, ack: number, origins: Map<number, [number, number]>): Omit<Snapshot, "m"> {
  const me = meOf(a.players.find((p) => p.id === you));
  return {
    t: "snapshot",
    tick: a.tick,
    ack,
    p: a.players.map((p) => {
      const self = p.id === you;
      const alive = p.alive;
      let fx = 0;
      if (alive) for (let i = 0; i < p.effect.length; i++) if (p.effect[i]! > 0) fx |= 1 << i;
      return [p.id, self ? q2(p.x) : q1(p.x), self ? q2(p.y) : q1(p.y), self ? q2(p.vx) : 0, self ? q2(p.vy) : 0, q2(p.aim), alive ? 1 : 0, alive && p.invulnTicks > 0 ? 1 : 0, alive && p.dashTicks > 0 ? 1 : 0, alive && p.protectTicks > 0 ? 1 : 0, fx];
    }),
    b: byId(
      a.bugs
        .filter((g) => inBox(box, Math.round(g.x), Math.round(g.y)))
        .map((g) => (g.phase === 0 ? [g.id, BUG_KINDS.indexOf(g.kind), Math.round(g.x), Math.round(g.y)] : [g.id, BUG_KINDS.indexOf(g.kind), Math.round(g.x), Math.round(g.y), g.phase, q2(Math.atan2(g.dy, g.dx)), g.phaseTicks])),
    ) as Snapshot["b"],
    s: a.events.shotsFired.filter((s) => inBox(box, s.x, s.y, SHOT_RANGE)).map((s) => [s.id, s.owner, q1(s.x), q1(s.y), q3(s.angle), s.drone ? 2 : s.laser ? 1 : 0]),
    e: a.events.shotsEnded
      .filter((e) => {
        const o = origins.get(e.id);
        return o !== undefined && inBox(box, o[0], o[1], SHOT_RANGE);
      })
      .map((e) => [e.id, e.blocked ? 2 : e.hit ? 1 : 0, q1(e.travelled)]),
    k: a.events.kills.filter((k) => (you !== 0 && k.by === you) || inBox(box, k.x, k.y)).map((k) => [k.bug, k.by, q1(k.x), q1(k.y), k.points, BUG_KINDS.indexOf(k.kind)]),
    d: a.players.filter((p) => p.down).map((p) => [p.id, q2((Math.max(0, DOWN_TICKS - (a.tick - p.downTick)) * TICK_MS) / 1000), p.reviver, q2(p.reviveTicks / REVIVE_TICKS)]),
    f: byId(
      a.floor.filter((x) => inBox(box, Math.round(x.x * 10) / 10, Math.round(x.y * 10) / 10)).map((x) => [x.id, PICKUP_IDS.indexOf(x.kind), q1(x.x), q1(x.y), x.ticksLeft]),
    ) as Snapshot["f"],
    w: wave(a.tick),
    q: queenExpected(a),
    g: goldenExpected(a),
    me: { ...me, he: q2(me.he), x: q2(me.x), y: q2(me.y), vx: q2(me.vx), vy: q2(me.vy) },
  };
}

/** The golden bug as every recipient should decode it (#122): never culled, whole units. */
function goldenExpected(a: ArenaState): Snapshot["g"] {
  const g = a.bugs.find((b) => b.kind === "golden");
  return g ? [g.id, Math.round(g.x), Math.round(g.y)] : [];
}

/** The hive queen as every recipient should decode her (#85): never culled, whole units. */
function queenExpected(a: ArenaState): Snapshot["q"] {
  const q = a.queen;
  if (q.stage === 1) return [0, Math.round(q.x), Math.round(q.y), q.ticksLeft];
  const g = q.stage === 2 ? a.bugs.find((b) => b.id === q.bugId) : undefined;
  return g ? [1, g.id, Math.round(g.x), Math.round(g.y), g.hp, q.maxHp] : [];
}

const comparable = (s: Snapshot) => {
  const { m: _m, ...rest } = s;
  return { ...rest, b: byId(rest.b as number[][]), f: byId(rest.f as number[][]), me: { ...rest.me, mu: 1, hl: 0 } };
};

/** An arena well into a fight: four players driven by the fill policy, old enough for every bug kind to spawn and act. */
function busyArena() {
  const { a, ps } = arenaWith([500, 500], [650, 550], [400, 650], [2000, 2000]);
  for (const p of ps) {
    p.firstLife = false;
    p.lifeStartTick = -20 * 120; // two minutes of pressure: dashers, spitters and beetles all spawn
  }
  const kinds: BugKind[] = ["crawler", "dasher", "spitter", "beetle"];
  for (let i = 0; i < 24; i++) placeBug(a, 700 + (i % 6) * 220, 700 + Math.floor(i / 6) * 300, kinds[i % kinds.length]);
  placePickup(a, 560, 560, "shield").ticksLeft = 50; // goes mid-run: a delta drops it
  placePickup(a, 2200, 300, "laser");
  // A CI drone on the first player (#84): its shots go out with style 2 and its effects bit is set.
  ps[0]!.effect[PICKUP_IDS.indexOf("drone")] = 20 * 12;
  const bots = ps.map((p, i) => ({ p, obs: createObservation(), mem: createFillMemory(), rng: createRng(100 + i), out: { mx: 0, my: 0, aim: 0, fire: false, dash: false } as PolicyInput }));
  const drive = () => {
    for (const b of bots) {
      if (!a.players.includes(b.p)) continue;
      observe(a, b.p.id, WORLD_W, WORLD_H, b.obs);
      fillBot(b.obs, b.mem, b.rng, b.out);
      Object.assign(b.p.input, { seq: b.p.input.seq + 1, ...b.out });
    }
  };
  return { a, ps, drive };
}

describe("encode, then decode, equals the arena culled and quantized", () => {
  test("a player's view and the watchers' view, every tick for 200 ticks of a real fight, through joins, leaves, downs, phases and pickups", () => {
    const { a, ps, drive } = busyArena();
    const you = ps[0]!;
    const frame = createArenaFrame();
    const mine = createViewState();
    const watch = createViewState();
    const readMine = createViewMirror();
    const readWatch = createViewMirror();
    const origins = new Map<number, [number, number]>();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    let late: Player | null = null;
    let droneShots = 0;
    const seen = { keys: 0, gone: 0, bt: 0, nb: 0, phases: new Set<number>(), downs: 0, joins: 0, leaves: 0, floorGone: 0, culledBugs: 0, culledShots: 0 };
    for (let t = 0; t < 200; t++) {
      drive();
      if (t === 40) {
        late = joinPlayer(a, "late", "tabs");
        seen.joins++;
      }
      if (t === 120) {
        leavePlayer(a, ps[3]!.id);
        seen.leaves++;
      }
      if (t === 60) {
        // Down a teammate in view, so `d` changes and a revive can start.
        ps[1]!.hits = 2;
        ps[1]!.invulnTicks = 0;
        ps[1]!.protectTicks = 0;
        placeBug(a, ps[1]!.x + 5, ps[1]!.y);
      }
      stepArena(a);
      for (const s of a.events.shotsFired) origins.set(s.id, [s.x, s.y]);
      const f = quantizeArena(a, wave(a.tick), frame);
      const boxNow = viewBoxOf(you.x, you.y, box);
      const wireMine = parseServerMessage(encodeView(f, mine, boxNow, you.id, t, meOf(you))) as WireSnapshot;
      const wireWatch = parseServerMessage(encodeView(f, watch, null, 0, 0, meOf(undefined))) as WireSnapshot;
      const gotMine = applySnapshot(readMine, wireMine)!;
      const gotWatch = applySnapshot(readWatch, wireWatch)!;
      expect(comparable(gotMine)).toEqual(expected(a, { ...boxNow }, you.id, t, origins));
      expect(comparable(gotWatch)).toEqual(expected(a, null, 0, 0, origins));
      // The first snapshot, and every KEYFRAME_TICKS after, is a keyframe; the rest are deltas on the one before.
      expect(wireMine.key === 1).toBe(t % KEYFRAME_TICKS === 0);
      if (wireMine.key !== 1) expect(wireMine.base).toBe(a.tick - 1);
      if (wireMine.key === 1) seen.keys++;
      droneShots += gotMine.s.filter((r) => r[5] === 2).length;
      seen.gone += wireMine.gb?.length ?? 0;
      seen.bt += wireMine.bt?.length ?? 0;
      seen.nb += wireMine.nb?.length ?? 0;
      seen.floorGone += wireMine.gf?.length ?? 0;
      if (wireMine.d && wireMine.d.length > 0) seen.downs++;
      for (const b of a.bugs) seen.phases.add(BUG_KINDS.indexOf(b.kind) * 10 + b.phase);
      seen.culledBugs = Math.max(seen.culledBugs, a.bugs.length - gotMine.b.length);
      seen.culledShots = Math.max(seen.culledShots, gotWatch.s.length - gotMine.s.length);
      for (const e of a.events.shotsEnded) origins.delete(e.id);
    }
    // The run covered what it claims to.
    expect(late).not.toBeNull();
    expect(droneShots).toBeGreaterThan(0);
    expect(seen.keys).toBe(10);
    expect(seen.gone).toBeGreaterThan(0);
    expect(seen.nb).toBeGreaterThan(0);
    expect(seen.bt).toBeGreaterThan(0);
    expect(seen.downs).toBeGreaterThan(0);
    expect(seen.floorGone).toBeGreaterThan(0);
    expect(seen.culledBugs).toBeGreaterThan(0);
    expect(seen.culledShots).toBeGreaterThan(0);
    // Dashers, spitters (and their globs) and beetles all left phase 0 at some point.
    for (const kind of ["dasher", "spitter", "beetle"] as const) expect([...seen.phases].some((x) => Math.floor(x / 10) === BUG_KINDS.indexOf(kind) && x % 10 !== 0)).toBe(true);
    expect([...seen.phases].some((x) => Math.floor(x / 10) === BUG_KINDS.indexOf("glob"))).toBe(true);
  });

  test("the minimap's far bugs come on keyframes only: every bug outside the view but globs, as cells, and none inside it", () => {
    const { a, ps } = arenaWith([600, 600]);
    const box = viewBoxOf(600, 600, { cx: 0, cy: 0, half: 0 });
    const near = placeBug(a, 700, 650);
    const far = placeBug(a, 2000, 2100, "beetle");
    const farGlob = placeBug(a, 2100, 300, "glob");
    const frame = createArenaFrame();
    const vs = createViewState();
    const mirror = createViewMirror();
    const decode = () => applySnapshot(mirror, parseServerMessage(encodeView(quantizeArena(a, 1, frame), vs, box, ps[0]!.id, 0, meOf(ps[0]))) as WireSnapshot)!;
    const key = decode();
    expect(key.b.map((r) => r[0])).toEqual([near.id]);
    expect(key.m).toEqual([Math.round(far.x / MINIMAP_CELL), Math.round(far.y / MINIMAP_CELL)]);
    expect(farGlob.id).toBeGreaterThan(0);
    for (let i = 1; i < KEYFRAME_TICKS; i++) {
      a.tick++;
      expect(decode().m).toBeUndefined();
    }
    a.tick++;
    expect(decode().m).toHaveLength(2);
    // A watcher sees every bug and gets no minimap list.
    const w = applySnapshot(createViewMirror(), parseServerMessage(encodeView(quantizeArena(a, 1, frame), createViewState(), null, 0, 0, meOf(undefined))) as WireSnapshot)!;
    expect(w.b).toHaveLength(3);
    expect(w.m).toBeUndefined();
  });

  test("an older pickup entering the view beside one already held arrives once, and the held one is not sent again", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    const older = placePickup(a, 1900, 1200, "laser");
    const newer = placePickup(a, 1300, 1200, "shield");
    const frame = createArenaFrame();
    const vs = createViewState();
    const mirror = createViewMirror();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    const decode = () => applySnapshot(mirror, parseServerMessage(encodeView(quantizeArena(a, 1, frame), vs, viewBoxOf(p.x, p.y, box), p.id, 0, meOf(p))) as WireSnapshot)!;
    expect(decode().f.map((r) => r[0])).toEqual([newer.id]);
    p.x = 1400;
    a.tick++;
    const got = decode();
    expect(got.f.map((r) => r[0]).sort((x, y) => x - y)).toEqual([older.id, newer.id]);
  });

  test("your own row is exact to 0.01 and carries your velocity; others' rows are to 0.1 with none", () => {
    const { a, ps } = arenaWith([1000.123, 1000.987], [1100.456, 1000.044]);
    ps[0]!.vx = 123.456;
    ps[1]!.vx = 77;
    const snap = applySnapshot(createViewMirror(), parseServerMessage(encodeView(quantizeArena(a, 1, createArenaFrame()), createViewState(), viewBoxOf(ps[0]!.x, ps[0]!.y, { cx: 0, cy: 0, half: 0 }), ps[0]!.id, 0, meOf(ps[0]))) as WireSnapshot)!;
    expect(snap.p[0]!.slice(0, 5)).toEqual([ps[0]!.id, 1000.12, 1000.99, 123.46, 0]);
    expect(snap.p[1]!.slice(0, 5)).toEqual([ps[1]!.id, 1100.5, 1000, 0, 0]);
  });
});

describe("the hive queen (#85)", () => {
  test("her marker, her health and her kill reach a player while her bug row is culled from their view, through keyframes and deltas", () => {
    const { a, ps } = arenaWith([200, 200]);
    const p = ps[0]!;
    p.invulnTicks = 1e9;
    a.tick = Math.round(((QUEEN_EVERY_WAVES - 1) * WAVE_S) / DT);
    const frame = createArenaFrame();
    const vs = createViewState();
    const mirror = createViewMirror();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    const seen: Snapshot["q"][] = [];
    let deltas = 0;
    let qOnDeltas = 0;
    let outside = 0;
    for (let t = 0; t < QUEEN_MARKER_TICKS + 60; t++) {
      p.budget = 0;
      if (a.queen.stage === 2 && t === QUEEN_MARKER_TICKS + 30) a.bugs.find((b) => b.id === a.queen.bugId)!.hp = 5;
      stepArena(a);
      viewBoxOf(p.x, p.y, box);
      const wire = parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, box, p.id, 0, meOf(p))) as WireSnapshot;
      if (wire.key !== 1) {
        deltas++;
        if (wire.q) qOnDeltas++;
      }
      const got = applySnapshot(mirror, wire)!;
      expect(got.q).toEqual(queenExpected(a));
      if (a.queen.stage === 2 && !inBox(box, Math.round(a.queen.x), Math.round(a.queen.y), 60)) {
        // Outside this player's view square: her bug row is culled, her `q` is not.
        outside++;
        expect(got.b.some((r) => r[0] === a.queen.bugId)).toBe(false);
      }
      seen.push(got.q);
    }
    expect(seen.some((q) => q[0] === 0)).toBe(true);
    expect(seen.some((q) => q[0] === 1)).toBe(true);
    expect(outside).toBeGreaterThan(0);
    // The marker's wire row holds still while it counts down, so most deltas carry no `q`.
    expect(qOnDeltas).toBeLessThan(deltas);
    // Killed: back to [] for everyone.
    a.bugs.find((b) => b.id === a.queen.bugId)!.hp = 0;
    a.queen.stage = 0;
    stepArena(a);
    expect(applySnapshot(mirror, parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, viewBoxOf(p.x, p.y, box), p.id, 0, meOf(p))) as WireSnapshot)!.q).toEqual([]);
  });
});

describe("the golden bug (#122)", () => {
  test("where it is reaches a player while its bug row is culled from their view, through keyframes and deltas, and is [] once it is gone; it is no far minimap cell", () => {
    const { a, ps } = arenaWith([200, 200]);
    const p = ps[0]!;
    p.invulnTicks = 1e9;
    const g = placeBug(a, 1500, 1500, "golden");
    const frame = createArenaFrame();
    const vs = createViewState();
    const mirror = createViewMirror();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    let deltas = 0;
    let gOnDeltas = 0;
    for (let t = 0; t < 30; t++) {
      p.budget = 0;
      stepArena(a);
      viewBoxOf(p.x, p.y, box);
      const wire = parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, box, p.id, 0, meOf(p))) as WireSnapshot;
      if (wire.key !== 1) {
        deltas++;
        if (wire.g) gOnDeltas++;
      }
      const got = applySnapshot(mirror, wire)!;
      expect(got.g).toEqual(goldenExpected(a));
      expect(got.g).toEqual([g.id, Math.round(g.x), Math.round(g.y)]);
      // Far outside this player's view square: its row is culled, `g` is not.
      expect(got.b.some((r) => r[0] === g.id)).toBe(false);
    }
    // It flees every tick, so every delta carries its new spot.
    expect(gOnDeltas).toBe(deltas);
    // A keyframe's far cells leave it out: its gold mark comes from `g`.
    const key = parseServerMessage(keyframeOf(frame, vs, viewBoxOf(p.x, p.y, box), p.id, 0, meOf(p))) as WireSnapshot;
    expect(key.m).toEqual([]);
    // Gone: [] for everyone, once.
    g.hp = 0;
    a.bugs.length = 0;
    stepArena(a);
    const after = parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, viewBoxOf(p.x, p.y, box), p.id, 0, meOf(p))) as WireSnapshot;
    expect(applySnapshot(mirror, after)!.g).toEqual([]);
  });
});

describe("keyframes and resync", () => {
  test("a lost delta decodes to null until the next keyframe, which is exact again", () => {
    const { a, drive, ps } = busyArena();
    const frame = createArenaFrame();
    const vs = createViewState();
    const mirror = createViewMirror();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    const origins = new Map<number, [number, number]>();
    let nulls = 0;
    for (let t = 0; t < 2 * KEYFRAME_TICKS + 1; t++) {
      drive();
      stepArena(a);
      for (const s of a.events.shotsFired) origins.set(s.id, [s.x, s.y]);
      const wire = parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, viewBoxOf(ps[0]!.x, ps[0]!.y, box), ps[0]!.id, 0, meOf(ps[0]))) as WireSnapshot;
      // Tick 5's snapshot never arrives.
      if (t === 5) continue;
      const got = applySnapshot(mirror, wire);
      if (t > 5 && t < KEYFRAME_TICKS) {
        expect(got).toBeNull();
        nulls++;
      } else expect(comparable(got!)).toEqual(expected(a, { ...box }, ps[0]!.id, 0, origins));
      for (const e of a.events.shotsEnded) origins.delete(e.id);
    }
    expect(nulls).toBe(KEYFRAME_TICKS - 6);
  });

  test("needKey makes the next snapshot a keyframe, and keyframeOf after a delta describes the same arena", () => {
    const { a, drive } = busyArena();
    const frame = createArenaFrame();
    const vs = createViewState();
    const steady = createViewMirror();
    for (let t = 0; t < 5; t++) {
      drive();
      stepArena(a);
      applySnapshot(steady, parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, null, 0, 0, meOf(undefined))) as WireSnapshot);
    }
    drive();
    stepArena(a);
    const f = quantizeArena(a, wave(a.tick), frame);
    const delta = parseServerMessage(encodeView(f, vs, null, 0, 0, meOf(undefined))) as WireSnapshot;
    expect(delta.key).toBeUndefined();
    // A watcher arriving now gets the keyframe of the same state the others' delta leads to.
    const fresh = applySnapshot(createViewMirror(), parseServerMessage(keyframeOf(f, vs, null, 0, 0, meOf(undefined))) as WireSnapshot)!;
    expect(fresh).toEqual(applySnapshot(steady, delta)!);
    vs.needKey = true;
    drive();
    stepArena(a);
    expect((parseServerMessage(encodeView(quantizeArena(a, wave(a.tick), frame), vs, null, 0, 0, meOf(undefined))) as WireSnapshot).key).toBe(1);
  });

  test("the reader resets on a welcome: a delta after it waits for a keyframe", () => {
    const { a } = arenaWith([1200, 1200]);
    const frame = createArenaFrame();
    const vs = createViewState();
    const read = createSnapshotReader();
    const send = () => read(parseServerMessage(encodeView(quantizeArena(a, 1, frame), vs, null, 0, 0, meOf(undefined)))!);
    expect(send()).not.toBeNull();
    a.tick++;
    expect(send()).not.toBeNull();
    read({ t: WELCOME, v: PROTOCOL_VERSION, you: 0, arena: 1, build: "", world: { w: WORLD_W, h: WORLD_H }, tickMs: TICK_MS, tick: a.tick, roster: [] });
    a.tick++;
    expect(send()).toBeNull();
  });
});

describe("size", () => {
  test(`a full arena all in view (150 bugs of every kind, 20 players moving and firing in bursts): a delta under 2000 B, a keyframe under 4500 B`, () => {
    const spots: [number, number][] = [];
    for (let i = 0; i < MAX_PLAYERS_PER_ARENA; i++) spots.push([1000 + (i % 5) * 80, 1000 + Math.floor(i / 5) * 80]);
    const { a, ps } = arenaWith(...spots);
    const kinds: BugKind[] = ["crawler", "crawler", "dasher", "spitter", "beetle"];
    let placed = 0;
    // Bugs that die or touch a robot are replaced, so the view always holds 150.
    const topUp = () => {
      while (a.bugs.length < 150) {
        const i = placed++;
        placeBug(a, 700 + (i % 15) * 60, 700 + (Math.floor(i / 15) % 10) * 60, kinds[i % kinds.length]).hp = 1000;
      }
    };
    for (const p of ps) {
      p.firstLife = false;
      p.lifeStartTick = -20 * 120;
      p.hits = -1000; // nobody goes down, so every robot keeps moving
    }
    const you = ps[7]!;
    const frame = createArenaFrame();
    const vs = createViewState();
    const box: ViewBox = { cx: 0, cy: 0, half: 0 };
    let maxDelta = 0;
    let maxKey = 0;
    // Each robot fires in bursts (13 ticks of 20), out of step with the others, as players do.
    for (let t = 0; t < 3 * KEYFRAME_TICKS; t++) {
      for (const [i, p] of ps.entries()) Object.assign(p.input, { seq: t + 1, mx: Math.cos(t / 7 + i), my: Math.sin(t / 7 + i), aim: t / 5 + i, fire: (t + i * 3) % 20 < 13, dash: false });
      for (const p of a.players) p.budget = 0;
      topUp();
      stepArena(a);
      topUp();
      const msg = encodeView(quantizeArena(a, wave(a.tick), frame), vs, viewBoxOf(you.x, you.y, box), you.id, t, meOf(you));
      const wire = JSON.parse(msg) as WireSnapshot;
      if (wire.key) maxKey = Math.max(maxKey, msg.length);
      // The first second is every bug placed at once and every dasher's tell starting together.
      else if (t >= KEYFRAME_TICKS) maxDelta = Math.max(maxDelta, msg.length);
      // Globs and the odd bug chasing a robot past the edge aside, the whole swarm is in view.
      if (wire.key) expect((wire.b as number[][]).length).toBeGreaterThanOrEqual(140);
    }
    expect(maxDelta).toBeGreaterThan(0);
    expect(maxDelta).toBeLessThan(2000);
    expect(maxKey).toBeLessThan(4500);
    expect(VIEW_HALF).toBe(600);
  });
});
