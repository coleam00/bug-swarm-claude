// Shots and kills as the browser draws them (#55). The server sends a shot once, when it is fired
// (where it left the barrel, its angle, its tick) and once when it ends (hit or miss, and how far
// it flew), so the browser flies it itself with the server's own rule, shotTravelAt: a shot is a
// straight line at constant speed. A kill waits in a queue until the drawing time reaches its
// tick, so its burst shows when the bug is seen to die. Both are fixed pools in typed arrays: a
// frame allocates nothing. Times are server ticks (fractional between ticks). Pure.
import { SHOT_RANGE } from "../../shared/arena/constants";
import { shotTravelAt } from "../../shared/arena/combat";

/**
 * The most shots drawn at once. A full arena has at most about 110 live shots (20 players x 7/s
 * x 0.78 s of flight); ended shots linger until drawn to their end, so this leaves room to spare.
 * The server ends every shot it fires, so every slot is let go by its end.
 */
export const SHOT_CAPACITY = 512;

export type ClientShots = {
  id: Int32Array;
  owner: Int32Array;
  x0: Float32Array;
  y0: Float32Array;
  dx: Float32Array;
  dy: Float32Array;
  /** The snapshot tick that reported it fired. */
  fired: Float64Array;
  /** The snapshot tick that reported its end, or -1 while it flies. */
  endTick: Float64Array;
  /** How far it flew in all, once ended. */
  endTravel: Float32Array;
  hit: Uint8Array;
  used: Uint8Array;
  /** Shot id to its slot. */
  slots: Map<number, number>;
  live: number;
  cursor: number;
};

export function createShots(capacity = SHOT_CAPACITY): ClientShots {
  return {
    id: new Int32Array(capacity),
    owner: new Int32Array(capacity),
    x0: new Float32Array(capacity),
    y0: new Float32Array(capacity),
    dx: new Float32Array(capacity),
    dy: new Float32Array(capacity),
    fired: new Float64Array(capacity),
    endTick: new Float64Array(capacity),
    endTravel: new Float32Array(capacity),
    hit: new Uint8Array(capacity),
    used: new Uint8Array(capacity),
    slots: new Map(),
    live: 0,
    cursor: 0,
  };
}

/** Forgets every shot (a new arena). */
export function clearShots(s: ClientShots): void {
  s.used.fill(0);
  s.slots.clear();
  s.live = 0;
}

function free(s: ClientShots, i: number): void {
  s.used[i] = 0;
  s.slots.delete(s.id[i]!);
  s.live--;
}

/** A shot fired, from a snapshot's `s`. A full pool overwrites the oldest slot. */
export function addShot(s: ClientShots, id: number, owner: number, x: number, y: number, angle: number, tick: number): void {
  const cap = s.used.length;
  const i = s.cursor;
  s.cursor = (i + 1) % cap;
  if (s.used[i]) free(s, i);
  s.used[i] = 1;
  s.live++;
  s.id[i] = id;
  s.owner[i] = owner;
  s.x0[i] = x;
  s.y0[i] = y;
  s.dx[i] = Math.cos(angle);
  s.dy[i] = Math.sin(angle);
  s.fired[i] = tick;
  s.endTick[i] = -1;
  s.endTravel[i] = SHOT_RANGE;
  s.hit[i] = 0;
  s.slots.set(id, i);
}

/** A shot ended, from a snapshot's `e`. An unknown id (fired before we joined) is ignored. */
export function endShot(s: ClientShots, id: number, hit: boolean, travelled: number, tick: number): void {
  const i = s.slots.get(id);
  if (i === undefined) return;
  s.endTick[i] = tick;
  s.endTravel[i] = travelled;
  s.hit[i] = hit ? 1 : 0;
}

/**
 * How far shot slot `i` has flown at tick `at`, or -1 when it is not drawn then: before it left
 * the barrel, or once its end is reached.
 */
export function shotTravel(s: ClientShots, i: number, at: number): number {
  if (!s.used[i]) return -1;
  const fired = s.fired[i]!;
  if (at < fired - 1) return -1;
  const end = s.endTick[i]!;
  if (end >= 0 && at >= end) return -1;
  return Math.min(shotTravelAt(fired, at), s.endTravel[i]!);
}

/**
 * Lets go of shots whose end the drawing time `at` has reached, calling `onHit` at the spot of
 * each one that hit (for its spark). `isMine(owner)` picks which shots this call handles: yours
 * are drawn at your own time, everyone else's 100 ms behind.
 */
export function pruneShots(s: ClientShots, at: number, isMine: (owner: number) => boolean, mine: boolean, onHit: (x: number, y: number) => void): void {
  if (s.live === 0) return;
  const cap = s.used.length;
  for (let i = 0; i < cap; i++) {
    if (!s.used[i] || isMine(s.owner[i]!) !== mine) continue;
    const end = s.endTick[i]!;
    if (end >= 0 && at >= end) {
      if (s.hit[i]) onHit(s.x0[i]! + s.dx[i]! * s.endTravel[i]!, s.y0[i]! + s.dy[i]! * s.endTravel[i]!);
      free(s, i);
    }
  }
}

/** Kills waiting to be shown, in a ring. */
export type KillQueue = {
  tick: Float64Array;
  x: Float32Array;
  y: Float32Array;
  points: Uint16Array;
  by: Int32Array;
  used: Uint8Array;
  cursor: number;
  live: number;
};

export const KILL_CAPACITY = 256;

export function createKillQueue(capacity = KILL_CAPACITY): KillQueue {
  return {
    tick: new Float64Array(capacity),
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    points: new Uint16Array(capacity),
    by: new Int32Array(capacity),
    used: new Uint8Array(capacity),
    cursor: 0,
    live: 0,
  };
}

/** A kill from a snapshot's `k`, shown once the drawing time reaches `tick`. A full ring drops the oldest. */
export function queueKill(q: KillQueue, tick: number, x: number, y: number, points: number, by: number): void {
  const i = q.cursor;
  q.cursor = (i + 1) % q.used.length;
  if (!q.used[i]) q.live++;
  q.used[i] = 1;
  q.tick[i] = tick;
  q.x[i] = x;
  q.y[i] = y;
  q.points[i] = points;
  q.by[i] = by;
}

/** Shows every queued kill whose tick `at` has reached (`isMine` picks yours, timed like your shots). */
export function drainKills(
  q: KillQueue,
  at: number,
  isMine: (by: number) => boolean,
  mine: boolean,
  show: (x: number, y: number, points: number, by: number) => void,
): void {
  if (q.live === 0) return;
  for (let i = 0; i < q.used.length; i++) {
    if (!q.used[i] || isMine(q.by[i]!) !== mine || at < q.tick[i]!) continue;
    q.used[i] = 0;
    q.live--;
    show(q.x[i]!, q.y[i]!, q.points[i]!, q.by[i]!);
  }
}

export function clearKills(q: KillQueue): void {
  q.used.fill(0);
  q.live = 0;
}
