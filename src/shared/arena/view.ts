// What each socket sees of an arena, and how it travels (v11, #89): snapshots culled to the
// recipient's view, quantized, sent as a keyframe every KEYFRAME_TICKS with integer deltas between.
// protocol.ts WireSnapshot documents the format.
//
// Server side, per room tick: `quantizeArena` turns the arena into an ArenaFrame once (whole-unit
// bugs, players to 0.1, this tick's events), then `encodeView` writes each recipient's snapshot
// from that frame and the recipient's ViewState, the copy of what it was last sent. A ViewState
// with `needKey` set (a new socket, or one whose last send was dropped) gets a keyframe. Watchers
// share one ViewState with no box (they see the whole arena) and `keyframeOf` serves the ones that
// joined mid-stream.
//
// Client side: `createSnapshotReader` keeps the mirror of what this socket was sent and decodes
// each wire snapshot back into protocol.ts's Snapshot. A delta whose base is not the mirror's tick
// (one was lost) decodes to null until the next keyframe.
//
// A player gets every player (the minimap, help arrows and the watchers' drift need them all),
// every downed player, and the bugs, pickups and kills inside a square VIEW_MAX / 2 + CULL_MARGIN
// from where their camera centres (bugs/index.ts viewCentre); shots that start within SHOT_RANGE
// of that square; and on keyframes the minimap's far bugs as coarse cells (`m`).
import { viewCentre } from "./bugs/index";
import {
  BUG_KINDS,
  CULL_MARGIN,
  DOWN_TICKS,
  KEYFRAME_TICKS,
  MINIMAP_CELL,
  PICKUP_IDS,
  REVIVE_TICKS,
  SHOT_RANGE,
  TICK_MS,
  VIEW_MAX,
  WORLD_H,
  WORLD_W,
} from "./constants";
import {
  SHOT_DRONE,
  SHOT_GUN,
  SHOT_LASER,
  SNAPSHOT,
  WELCOME,
  type ServerMessage,
  type Snapshot,
  type SnapshotBug,
  type SnapshotMe,
  type SnapshotPlayer,
  type SnapshotQueen,
  type WireMessage,
  type WireSnapshot,
} from "./protocol";
import { GOLDEN_KIND } from "./golden";
import type { ArenaState } from "./sim";

/** Half the side of a player's view square, units. */
export const VIEW_HALF = VIEW_MAX / 2 + CULL_MARGIN;
const GLOB_KIND = BUG_KINDS.indexOf("glob");
const GOLDEN_INDEX = BUG_KINDS.indexOf(GOLDEN_KIND);

/** Player flag bits on the wire. */
export const FLAG_ALIVE = 1;
export const FLAG_INVULNERABLE = 2;
export const FLAG_DASHING = 4;
export const FLAG_PROTECTED = 8;

/** A view square: its centre and half side. */
export type ViewBox = { cx: number; cy: number; half: number };

/** The view square of a player at (x, y): around where their camera centres, clamped at the walls. */
export function viewBoxOf(x: number, y: number, out: ViewBox): ViewBox {
  out.cx = viewCentre(x, WORLD_W);
  out.cy = viewCentre(y, WORLD_H);
  out.half = VIEW_HALF;
  return out;
}

const inBox = (b: ViewBox | null, x: number, y: number, pad = 0) => b === null || (Math.abs(x - b.cx) <= b.half + pad && Math.abs(y - b.cy) <= b.half + pad);

/** One room tick's arena, quantized once for every recipient. Arrays are reused tick to tick. */
export type ArenaFrame = {
  tick: number;
  wave: number;
  bugs: number;
  bid: number[];
  bkind: number[];
  bx: number[];
  by: number[];
  bph: number[];
  bang: number[];
  bti: number[];
  /** Bug id to index this tick. */
  bIndex: Map<number, number>;
  /** Per bug, the stamp of the last encode that kept it (finds new ones without a set). */
  bmark: number[];
  players: number;
  pid: number[];
  px: number[];
  py: number[];
  pa: number[];
  pfl: number[];
  pfx: number[];
  floor: number;
  fid: number[];
  fkind: number[];
  fx: number[];
  fy: number[];
  fgone: number[];
  /** Per pickup, the stamp of the last encode whose recipient already held it (like bmark). */
  fmark: number[];
  /** Every downed player, as the wire's `d`. */
  downs: string;
  /** The hive queen as the wire's `q` (#85): never culled. */
  queen: string;
  /** The golden bug as the wire's `g` (#122): never culled. */
  golden: string;
  /** This tick's events as JSON rows, with where each happened for culling. */
  shots: string[];
  sx: number[];
  sy: number[];
  ends: string[];
  /** Where a shot end's shot started (every shot fires in a quantized tick, so it is known). */
  ex: number[];
  ey: number[];
  kills: string[];
  kx: number[];
  ky: number[];
  kby: number[];
  /** Where each shot in flight left the barrel, so its end is culled as it was. */
  originX: Map<number, number>;
  originY: Map<number, number>;
};

export function createArenaFrame(): ArenaFrame {
  return {
    tick: 0,
    wave: 0,
    bugs: 0,
    bid: [],
    bkind: [],
    bx: [],
    by: [],
    bph: [],
    bang: [],
    bti: [],
    bIndex: new Map(),
    bmark: [],
    players: 0,
    pid: [],
    px: [],
    py: [],
    pa: [],
    pfl: [],
    pfx: [],
    floor: 0,
    fid: [],
    fkind: [],
    fx: [],
    fy: [],
    fgone: [],
    fmark: [],
    downs: "[]",
    queen: "[]",
    golden: "[]",
    shots: [],
    sx: [],
    sy: [],
    ends: [],
    ex: [],
    ey: [],
    kills: [],
    kx: [],
    ky: [],
    kby: [],
    originX: new Map(),
    originY: new Map(),
  };
}

const q1 = (v: number) => Math.round(v * 10) / 10;
const q2 = (v: number) => Math.round(v * 100) / 100;
const q3 = (v: number) => Math.round(v * 1000) / 1000;

/** A player's flags: in a life, untouchable, dashing, spawn-protected (the last three only in a life). */
function flagsOf(p: ArenaState["players"][number]): number {
  if (!p.alive) return 0;
  return FLAG_ALIVE | (p.invulnTicks > 0 ? FLAG_INVULNERABLE : 0) | (p.dashTicks > 0 ? FLAG_DASHING : 0) | (p.protectTicks > 0 ? FLAG_PROTECTED : 0);
}

/** A player's effects as a bitmask: bit i while effect i is active in a life (v7). */
function effectBits(p: ArenaState["players"][number]): number {
  if (!p.alive) return 0;
  let bits = 0;
  for (let i = 0; i < p.effect.length; i++) if (p.effect[i]! > 0) bits |= 1 << i;
  return bits;
}

/**
 * The hive queen's wire `q` (#85): `[]`; her marker `[0, x, y, appearTick]` (the tick she appears, so
 * the string holds still while it counts down); or her alive `[1, id, x, y, hp, maxHp]`, whole units.
 */
function queenRow(state: ArenaState): string {
  const q = state.queen;
  if (q.stage === 1) return `[0,${Math.round(q.x)},${Math.round(q.y)},${state.tick + q.ticksLeft}]`;
  if (q.stage !== 2) return "[]";
  for (const g of state.bugs) if (g.id === q.bugId) return `[1,${g.id},${Math.round(g.x)},${Math.round(g.y)},${g.hp},${q.maxHp}]`;
  return "[]";
}

/** The golden bug's wire `g` (#122): `[]` with none alive, else `[id, x, y]` in whole units. */
function goldenRow(state: ArenaState): string {
  for (const g of state.bugs) if (g.kind === GOLDEN_KIND) return `[${g.id},${Math.round(g.x)},${Math.round(g.y)}]`;
  return "[]";
}

/**
 * Quantizes the arena after a step into `f`, once per room tick. `state.tick` is the snapshot's
 * tick. Remembers where each shot fired so its end is culled by the same spot.
 */
export function quantizeArena(state: ArenaState, wave: number, f: ArenaFrame): ArenaFrame {
  f.tick = state.tick;
  f.wave = wave;
  const bugs = state.bugs;
  f.bugs = bugs.length;
  f.bIndex.clear();
  for (let i = 0; i < bugs.length; i++) {
    const g = bugs[i]!;
    f.bid[i] = g.id;
    f.bkind[i] = BUG_KINDS.indexOf(g.kind);
    f.bx[i] = Math.round(g.x);
    f.by[i] = Math.round(g.y);
    f.bph[i] = g.phase;
    f.bang[i] = g.phase === 0 ? 0 : Math.round(Math.atan2(g.dy, g.dx) * 100);
    f.bti[i] = g.phase === 0 ? 0 : g.phaseTicks;
    f.bmark[i] = 0;
    f.bIndex.set(g.id, i);
  }
  const players = state.players;
  f.players = players.length;
  let d = "[";
  for (let i = 0; i < players.length; i++) {
    const p = players[i]!;
    f.pid[i] = p.id;
    f.px[i] = Math.round(p.x * 10);
    f.py[i] = Math.round(p.y * 10);
    f.pa[i] = Math.round(p.aim * 100);
    f.pfl[i] = flagsOf(p);
    f.pfx[i] = effectBits(p);
    if (!p.down) continue;
    if (d.length > 1) d += ",";
    d += `[${p.id},${p.downTick},${p.reviver},${Math.round((p.reviveTicks / REVIVE_TICKS) * 100)}]`;
  }
  f.downs = d + "]";
  f.queen = queenRow(state);
  f.golden = goldenRow(state);
  const floor = state.floor;
  f.floor = floor.length;
  for (let i = 0; i < floor.length; i++) {
    const x = floor[i]!;
    f.fid[i] = x.id;
    f.fkind[i] = PICKUP_IDS.indexOf(x.kind);
    f.fx[i] = Math.round(x.x * 10);
    f.fy[i] = Math.round(x.y * 10);
    f.fgone[i] = state.tick + x.ticksLeft;
    f.fmark[i] = 0;
  }
  const ev = state.events;
  f.shots.length = 0;
  for (let i = 0; i < ev.shotsFired.length; i++) {
    const s = ev.shotsFired[i]!;
    f.shots.push(`[${s.id},${s.owner},${q1(s.x)},${q1(s.y)},${q3(s.angle)},${s.drone ? SHOT_DRONE : s.laser ? SHOT_LASER : SHOT_GUN}]`);
    f.sx[i] = s.x;
    f.sy[i] = s.y;
    f.originX.set(s.id, s.x);
    f.originY.set(s.id, s.y);
  }
  f.ends.length = 0;
  for (let i = 0; i < ev.shotsEnded.length; i++) {
    const e = ev.shotsEnded[i]!;
    f.ends.push(`[${e.id},${e.blocked ? 2 : e.hit ? 1 : 0},${q1(e.travelled)}]`);
    f.ex[i] = f.originX.get(e.id)!;
    f.ey[i] = f.originY.get(e.id)!;
    f.originX.delete(e.id);
    f.originY.delete(e.id);
  }
  f.kills.length = 0;
  for (let i = 0; i < ev.kills.length; i++) {
    const k = ev.kills[i]!;
    f.kills.push(`[${k.bug},${k.by},${q1(k.x)},${q1(k.y)},${k.points},${BUG_KINDS.indexOf(k.kind)}]`);
    f.kx[i] = k.x;
    f.ky[i] = k.y;
    f.kby[i] = k.by;
  }
  return f;
}

/** What a recipient was last sent: its copy of the snapshot, in the order the receiver holds it. */
export type ViewState = {
  /** The next snapshot must be a keyframe (a new socket, or the last send was dropped). */
  needKey: boolean;
  /** Snapshots since the last keyframe. */
  sinceKey: number;
  /** The tick of the last snapshot sent (a delta's `base`). */
  lastTick: number;
  /** Whether the last encodeView wrote a keyframe. */
  wasKey: boolean;
  bugs: number;
  bid: number[];
  bkind: number[];
  bx: number[];
  by: number[];
  bph: number[];
  bang: number[];
  bti: number[];
  players: number;
  pid: number[];
  px: number[];
  py: number[];
  pa: number[];
  pfl: number[];
  pfx: number[];
  /** A scratch stamp per frame player, like ArenaFrame.bmark. */
  pmark: number[];
  floor: number;
  fid: number[];
  fkind: number[];
  fx: number[];
  fy: number[];
  fgone: number[];
  downs: string;
  /** The hive queen's `q` as last sent (#85). */
  queen: string;
  /** The golden bug's `g` as last sent (#122). */
  golden: string;
  wave: number;
  /** `me` as last sent, in ME_KEYS order, and its fx joined. */
  me: number[];
  meFx: string;
};

export function createViewState(): ViewState {
  return {
    needKey: true,
    sinceKey: 0,
    lastTick: -1,
    wasKey: false,
    bugs: 0,
    bid: [],
    bkind: [],
    bx: [],
    by: [],
    bph: [],
    bang: [],
    bti: [],
    players: 0,
    pid: [],
    px: [],
    py: [],
    pa: [],
    pfl: [],
    pfx: [],
    pmark: [],
    floor: 0,
    fid: [],
    fkind: [],
    fx: [],
    fy: [],
    fgone: [],
    downs: "",
    queen: "",
    golden: "",
    wave: -1,
    me: [],
    meFx: "",
  };
}

/** The numbers of `me` on the wire, in order; he, x, y, vx and vy go to 0.01. */
const ME_KEYS = ["sc", "ki", "st", "mu", "he", "lk", "hl", "al", "dk", "dc", "dn", "x", "y", "vx", "vy", "gc"] as const;
const ME_Q2 = new Set<string>(["he", "x", "y", "vx", "vy"]);

let stampSeq = 0;

/** A bug row as a keyframe or `nb` carries it. */
function bugRow(vs: ViewState, i: number): string {
  return vs.bph[i] === 0 ? `[${vs.bid[i]},${vs.bkind[i]},${vs.bx[i]},${vs.by[i]}]` : `[${vs.bid[i]},${vs.bkind[i]},${vs.bx[i]},${vs.by[i]},${vs.bph[i]},${vs.bang[i]},${vs.bti[i]}]`;
}
const playerRow = (vs: ViewState, i: number) => `[${vs.pid[i]},${vs.px[i]},${vs.py[i]},${vs.pa[i]},${vs.pfl[i]},${vs.pfx[i]}]`;
const floorRow = (vs: ViewState, i: number) => `[${vs.fid[i]},${vs.fkind[i]},${vs.fx[i]},${vs.fy[i]},${vs.fgone[i]}]`;

function copyBug(f: ArenaFrame, j: number, vs: ViewState, i: number): void {
  vs.bid[i] = f.bid[j]!;
  vs.bkind[i] = f.bkind[j]!;
  vs.bx[i] = f.bx[j]!;
  vs.by[i] = f.by[j]!;
  vs.bph[i] = f.bph[j]!;
  vs.bang[i] = f.bang[j]!;
  vs.bti[i] = f.bti[j]!;
}

function copyPlayer(f: ArenaFrame, j: number, vs: ViewState, i: number): void {
  vs.pid[i] = f.pid[j]!;
  vs.px[i] = f.px[j]!;
  vs.py[i] = f.py[j]!;
  vs.pa[i] = f.pa[j]!;
  vs.pfl[i] = f.pfl[j]!;
  vs.pfx[i] = f.pfx[j]!;
}

/** This tick's shots, shot ends and kills that `box` could see (`you`'s kills always), as `"s":..,"e":..,"k":..`. */
function eventsJson(f: ArenaFrame, box: ViewBox | null, you: number): string {
  let s = "";
  for (let i = 0; i < f.shots.length; i++) if (inBox(box, f.sx[i]!, f.sy[i]!, SHOT_RANGE)) s += (s ? "," : "") + f.shots[i];
  let e = "";
  for (let i = 0; i < f.ends.length; i++) if (inBox(box, f.ex[i]!, f.ey[i]!, SHOT_RANGE)) e += (e ? "," : "") + f.ends[i];
  let k = "";
  for (let i = 0; i < f.kills.length; i++) if ((you !== 0 && f.kby[i] === you) || inBox(box, f.kx[i]!, f.ky[i]!)) k += (k ? "," : "") + f.kills[i];
  return `"s":[${s}],"e":[${e}],"k":[${k}]`;
}

function meValue(me: SnapshotMe, k: (typeof ME_KEYS)[number]): number {
  const v = me[k];
  return ME_Q2.has(k) ? q2(v) : v;
}

/**
 * Brings `vs` to the frame as `box` sees it and writes the snapshot for this recipient: a
 * keyframe when `vs.needKey` is set or KEYFRAME_TICKS have passed since the last one, else a delta
 * against what it was last sent. `box` null sees everything (watchers). `me` is the recipient's
 * own numbers (all zero when watching).
 */
export function encodeView(f: ArenaFrame, vs: ViewState, box: ViewBox | null, you: number, ack: number, me: SnapshotMe): string {
  const key = vs.needKey || vs.sinceKey + 1 >= KEYFRAME_TICKS || vs.lastTick < 0;
  const base = vs.lastTick;
  const stamp = ++stampSeq;
  // Bugs: the ones kept, in mirror order, then the new ones.
  let gb = "";
  let b = "";
  let bt = "";
  let w = 0;
  for (let i = 0; i < vs.bugs; i++) {
    const j = f.bIndex.get(vs.bid[i]!);
    if (j === undefined || !inBox(box, f.bx[j]!, f.by[j]!)) {
      if (!key) gb += (gb ? "," : "") + i;
      continue;
    }
    f.bmark[j] = stamp;
    if (!key) {
      b += `${b ? "," : ""}${f.bx[j]! - vs.bx[i]!},${f.by[j]! - vs.by[i]!}`;
      if (vs.bph[i] !== 0) {
        if (f.bph[j] === vs.bph[i]) b += `,${f.bang[j]! - vs.bang[i]!},${f.bti[j]! - vs.bti[i]!}`;
        else b += ",0,0";
      }
      if (f.bph[j] !== vs.bph[i]) bt += `${bt ? "," : ""}[${w}${f.bph[j] === 0 ? "" : `,${f.bph[j]},${f.bang[j]},${f.bti[j]}`}]`;
    }
    copyBug(f, j, vs, w++);
  }
  let nb = "";
  for (let j = 0; j < f.bugs; j++) {
    if (f.bmark[j] === stamp || !inBox(box, f.bx[j]!, f.by[j]!)) continue;
    copyBug(f, j, vs, w);
    if (!key) nb += (nb ? "," : "") + bugRow(vs, w);
    w++;
  }
  vs.bugs = w;
  // Players: never culled.
  let gp = "";
  let p = "";
  let pf = "";
  w = 0;
  for (let j = 0; j < f.players; j++) vs.pmark[j] = 0;
  for (let i = 0; i < vs.players; i++) {
    let j = -1;
    for (let x = 0; x < f.players; x++) if (f.pid[x] === vs.pid[i]) j = x;
    if (j < 0) {
      if (!key) gp += (gp ? "," : "") + i;
      continue;
    }
    vs.pmark[j] = stamp;
    if (!key) {
      p += `${p ? "," : ""}${f.px[j]! - vs.px[i]!},${f.py[j]! - vs.py[i]!},${f.pa[j]! - vs.pa[i]!}`;
      if (f.pfl[j] !== vs.pfl[i] || f.pfx[j] !== vs.pfx[i]) pf += `${pf ? "," : ""}[${w},${f.pfl[j]},${f.pfx[j]}]`;
    }
    copyPlayer(f, j, vs, w++);
  }
  let np = "";
  for (let j = 0; j < f.players; j++) {
    if (vs.pmark[j] === stamp) continue;
    copyPlayer(f, j, vs, w);
    if (!key) np += (np ? "," : "") + playerRow(vs, w);
    w++;
  }
  vs.players = w;
  // Pickups: they never move or change, so a delta only says which came and went.
  // Which pickups the recipient already holds is stamped on the frame first (fmark), before the
  // loop below writes over vs.fid.
  let gf = "";
  for (let i = 0; i < vs.floor; i++) {
    let gone = true;
    for (let j = 0; j < f.floor; j++) {
      if (f.fid[j] !== vs.fid[i] || !inBox(box, f.fx[j]! / 10, f.fy[j]! / 10)) continue;
      gone = false;
      f.fmark[j] = stamp;
    }
    if (gone && !key) gf += (gf ? "," : "") + vs.fid[i];
  }
  let nf = "";
  w = 0;
  for (let j = 0; j < f.floor; j++) {
    if (!inBox(box, f.fx[j]! / 10, f.fy[j]! / 10)) continue;
    const had = f.fmark[j] === stamp;
    vs.fid[w] = f.fid[j]!;
    vs.fkind[w] = f.fkind[j]!;
    vs.fx[w] = f.fx[j]!;
    vs.fy[w] = f.fy[j]!;
    vs.fgone[w] = f.fgone[j]!;
    if (!had && !key) nf += (nf ? "," : "") + floorRow(vs, w);
    w++;
  }
  vs.floor = w;
  vs.needKey = false;
  vs.lastTick = f.tick;
  vs.wasKey = key;
  if (key) {
    vs.sinceKey = 0;
    return keyframeOf(f, vs, box, you, ack, me);
  }
  vs.sinceKey++;
  let out = `{"t":"${SNAPSHOT}","tick":${f.tick},"base":${base},"ack":${ack}`;
  if (gb) out += `,"gb":[${gb}]`;
  if (b) out += `,"b":[${b}]`;
  if (bt) out += `,"bt":[${bt}]`;
  if (nb) out += `,"nb":[${nb}]`;
  if (gp) out += `,"gp":[${gp}]`;
  if (p) out += `,"p":[${p}]`;
  if (pf) out += `,"pf":[${pf}]`;
  if (np) out += `,"np":[${np}]`;
  if (gf) out += `,"gf":[${gf}]`;
  if (nf) out += `,"nf":[${nf}]`;
  if (f.downs !== vs.downs) out += `,"d":${f.downs}`;
  vs.downs = f.downs;
  if (f.wave !== vs.wave) out += `,"w":${f.wave}`;
  vs.wave = f.wave;
  if (f.queen !== vs.queen) out += `,"q":${f.queen}`;
  vs.queen = f.queen;
  if (f.golden !== vs.golden) out += `,"g":${f.golden}`;
  vs.golden = f.golden;
  let m = "";
  for (let i = 0; i < ME_KEYS.length; i++) {
    const v = meValue(me, ME_KEYS[i]!);
    if (vs.me[i] !== v) m += `${m ? "," : ""}"${ME_KEYS[i]}":${v}`;
    vs.me[i] = v;
  }
  const fx = me.fx.join(",");
  if (fx !== vs.meFx) m += `${m ? "," : ""}"fx":[${fx}]`;
  vs.meFx = fx;
  if (m) out += `,"me":{${m}}`;
  return `${out},${eventsJson(f, box, you)}}`;
}

/**
 * A keyframe of what `vs` holds now: call it after encodeView in the same tick (watchers that
 * joined mid-stream get this while the rest get the delta). `box` adds the minimap's far bugs.
 */
export function keyframeOf(f: ArenaFrame, vs: ViewState, box: ViewBox | null, you: number, ack: number, me: SnapshotMe): string {
  let b = "";
  for (let i = 0; i < vs.bugs; i++) b += (i ? "," : "") + bugRow(vs, i);
  let p = "";
  for (let i = 0; i < vs.players; i++) p += (i ? "," : "") + playerRow(vs, i);
  let fl = "";
  for (let i = 0; i < vs.floor; i++) fl += (i ? "," : "") + floorRow(vs, i);
  let m = "";
  for (let i = 0; i < ME_KEYS.length; i++) {
    const v = meValue(me, ME_KEYS[i]!);
    vs.me[i] = v;
    m += `"${ME_KEYS[i]}":${v},`;
  }
  vs.meFx = me.fx.join(",");
  vs.downs = f.downs;
  vs.wave = f.wave;
  vs.queen = f.queen;
  vs.golden = f.golden;
  let out = `{"t":"${SNAPSHOT}","tick":${f.tick},"key":1,"you":${you},"ack":${ack},"p":[${p}],"b":[${b}],"f":[${fl}],"d":${f.downs},"w":${f.wave},"q":${f.queen},"g":${f.golden},"me":{${m}"fx":[${vs.meFx}]}`;
  if (box) {
    let far = "";
    for (let j = 0; j < f.bugs; j++) {
      // Globs are shots in flight; the golden bug has its own mark from `g` (#122).
      if (f.bkind[j] === GLOB_KIND || f.bkind[j] === GOLDEN_INDEX || inBox(box, f.bx[j]!, f.by[j]!)) continue;
      far += `${far ? "," : ""}${Math.round(f.bx[j]! / MINIMAP_CELL)},${Math.round(f.by[j]! / MINIMAP_CELL)}`;
    }
    out += `,"m":[${far}]`;
  }
  return `${out},${eventsJson(f, box, you)}}`;
}

/** The receiver's copy of what its socket was sent. */
export type ViewMirror = {
  /** The tick of the last snapshot applied; -1 until a keyframe. */
  tick: number;
  you: number;
  bugs: number[][];
  players: number[][];
  floor: number[][];
  downs: number[][];
  wave: number;
  /** The hive queen's wire `q` (#85). */
  queen: number[];
  /** The golden bug's wire `g` (#122). */
  golden: number[];
  me: SnapshotMe;
};

export function createViewMirror(): ViewMirror {
  return { tick: -1, you: 0, bugs: [], players: [], floor: [], downs: [], wave: 0, queen: [], golden: [], me: zeroMe() };
}

function zeroMe(): SnapshotMe {
  return { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0, fx: PICKUP_IDS.map(() => 0), x: 0, y: 0, vx: 0, vy: 0, gc: 0 };
}

/** Forgets everything: the next snapshot must be a keyframe (a new welcome). */
export function resetViewMirror(m: ViewMirror): void {
  m.tick = -1;
}

const flat = (v: number[] | number[][] | undefined) => (v ?? []) as number[];
const rows = (v: number[] | number[][] | undefined) => (v ?? []) as number[][];

/**
 * Applies one wire snapshot to the mirror and returns it decoded, or null when it cannot be: a
 * delta before any keyframe, or whose base is not the last snapshot applied (one was lost). The
 * mirror then waits for the next keyframe. The returned rows are new arrays, safe to keep.
 */
export function applySnapshot(m: ViewMirror, s: WireSnapshot): Snapshot | null {
  if (s.key === 1) {
    m.you = s.you ?? 0;
    m.bugs = rows(s.b).map((r) => r.slice());
    m.players = rows(s.p).map((r) => r.slice());
    m.floor = (s.f ?? []).map((r) => r.slice());
    m.downs = s.d ?? [];
    m.wave = s.w ?? 0;
    m.queen = s.q ?? [];
    m.golden = s.g ?? [];
    m.me = { ...zeroMe(), ...s.me };
  } else {
    if (m.tick < 0 || s.base !== m.tick) {
      m.tick = -1;
      return null;
    }
    const gb = s.gb ?? [];
    for (let i = gb.length - 1; i >= 0; i--) m.bugs.splice(gb[i]!, 1);
    const b = flat(s.b);
    let k = 0;
    for (const r of m.bugs) {
      r[2]! += b[k++]!;
      r[3]! += b[k++]!;
      if (r.length > 4) {
        r[5]! += b[k++]!;
        r[6]! += b[k++]!;
      }
    }
    for (const t of s.bt ?? []) {
      const r = m.bugs[t[0]!]!;
      r.length = 4;
      if (t.length > 1) r.push(t[1]!, t[2]!, t[3]!);
    }
    for (const r of s.nb ?? []) m.bugs.push(r.slice());
    const gp = s.gp ?? [];
    for (let i = gp.length - 1; i >= 0; i--) m.players.splice(gp[i]!, 1);
    const p = flat(s.p);
    k = 0;
    for (const r of m.players) {
      r[1]! += p[k++]!;
      r[2]! += p[k++]!;
      r[3]! += p[k++]!;
    }
    for (const t of s.pf ?? []) {
      const r = m.players[t[0]!]!;
      r[4] = t[1]!;
      r[5] = t[2]!;
    }
    for (const r of s.np ?? []) m.players.push(r.slice());
    const gf = s.gf ?? [];
    if (gf.length) m.floor = m.floor.filter((r) => !gf.includes(r[0]!));
    for (const r of s.nf ?? []) m.floor.push(r.slice());
    if (s.d) m.downs = s.d;
    if (s.w !== undefined) m.wave = s.w;
    if (s.q) m.queen = s.q;
    if (s.g) m.golden = s.g;
    if (s.me) Object.assign(m.me, s.me);
  }
  m.tick = s.tick;
  return decoded(m, s);
}

/** The wire `q` decoded at `tick` (#85): the marker's appear tick becomes the ticks left. */
function queenOf(q: number[], tick: number): SnapshotQueen {
  if (q[0] === 0) return [0, q[1]!, q[2]!, Math.max(0, q[3]! - tick)];
  if (q[0] === 1) return [1, q[1]!, q[2]!, q[3]!, q[4]!, q[5]!];
  return [];
}

function decoded(m: ViewMirror, s: WireSnapshot): Snapshot {
  const me = m.me;
  const p: SnapshotPlayer[] = m.players.map((r) => {
    const fl = r[4]!;
    const self = m.you !== 0 && r[0] === m.you;
    return [
      r[0]!,
      self ? me.x : r[1]! / 10,
      self ? me.y : r[2]! / 10,
      self ? me.vx : 0,
      self ? me.vy : 0,
      r[3]! / 100,
      fl & FLAG_ALIVE ? 1 : 0,
      fl & FLAG_INVULNERABLE ? 1 : 0,
      fl & FLAG_DASHING ? 1 : 0,
      fl & FLAG_PROTECTED ? 1 : 0,
      r[5]!,
    ];
  });
  const b: SnapshotBug[] = m.bugs.map((r) => (r.length > 4 ? [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]! / 100, r[6]!] : [r[0]!, r[1]!, r[2]!, r[3]!]));
  const out: Snapshot = {
    t: SNAPSHOT,
    tick: s.tick,
    ack: s.ack,
    p,
    b,
    s: s.s ?? [],
    e: s.e ?? [],
    k: s.k ?? [],
    d: m.downs.map((r) => [r[0]!, q2((Math.max(0, DOWN_TICKS - (s.tick - r[1]!)) * TICK_MS) / 1000), r[2]!, r[3]! / 100]),
    f: m.floor.map((r) => [r[0]!, r[1]!, r[2]! / 10, r[3]! / 10, r[4]! - s.tick]),
    w: m.wave,
    q: queenOf(m.queen, s.tick),
    g: m.golden.length === 3 ? [m.golden[0]!, m.golden[1]!, m.golden[2]!] : [],
    me: { ...me, fx: me.fx.slice() },
  };
  if (s.m) out.m = s.m;
  return out;
}

/**
 * One socket's reader: a welcome resets the mirror, a snapshot is decoded through it (null when it
 * cannot be: drop it), anything else passes through.
 */
export function createSnapshotReader(): (m: WireMessage) => ServerMessage | null {
  const mirror = createViewMirror();
  return (msg) => {
    if (msg.t === WELCOME) {
      resetViewMirror(mirror);
      return msg;
    }
    if (msg.t === SNAPSHOT) return applySnapshot(mirror, msg);
    return msg;
  };
}
