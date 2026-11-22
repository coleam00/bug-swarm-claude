// Interpolation of everyone else: the last few snapshots, and an estimate of the server's tick
// from when they arrived, so other players and the bugs are drawn INTERP_DELAY_MS behind the
// server, between two snapshots, and move smoothly at any frame rate. Pure: the frame time comes
// in as a number.
import { INTERP_DELAY_MS, TICK_MS } from "../../shared/arena/constants";
import type { SnapshotBug, SnapshotDown, SnapshotPickup, SnapshotPlayer } from "../../shared/arena/protocol";

/** Snapshots kept: half a second at 20 Hz. */
export const INTERP_BUFFER = 10;
/** How much of each new arrival the tick clock takes (smooths network jitter). */
export const CLOCK_GAIN = 0.1;
/** A clock this many ticks off is reset, not smoothed (a tab back from the background). */
export const CLOCK_RESET_TICKS = 5;
/** How far behind the server's tick other players are drawn, in ticks. */
export const DELAY_TICKS = INTERP_DELAY_MS / TICK_MS;

type Frame = {
  tick: number;
  p: SnapshotPlayer[];
  b: SnapshotBug[];
  /** The bugs by id, for the frame after the one drawn from. */
  bi: Map<number, SnapshotBug>;
  /** Who is down, with seconds left and revive progress. */
  d: SnapshotDown[];
  /** The pickups on the floor (v7, #73). */
  f: SnapshotPickup[];
};

export type Interp = {
  /** Oldest first. */
  frames: Frame[];
  /** Server tick = now / TICK_MS + offset, once a snapshot has arrived. */
  offset: number | null;
  /** The last render tick handed out, so drawing never goes backward in time. */
  lastRender: number;
};

export function createInterp(): Interp {
  return { frames: [], offset: null, lastRender: -Infinity };
}

export function resetInterp(it: Interp): void {
  it.frames.length = 0;
  it.offset = null;
  it.lastRender = -Infinity;
}

/** A snapshot arrived at `nowMs`. Out-of-order or repeated ticks are ignored. */
export function pushSnapshot(
  it: Interp,
  tick: number,
  players: SnapshotPlayer[],
  nowMs: number,
  bugs: SnapshotBug[] = [],
  downs: SnapshotDown[] = [],
  floor: SnapshotPickup[] = [],
): void {
  const newest = it.frames[it.frames.length - 1];
  if (newest && tick <= newest.tick) return;
  const bi = new Map<number, SnapshotBug>();
  for (const b of bugs) bi.set(b[0], b);
  it.frames.push({ tick, p: players, b: bugs, bi, d: downs, f: floor });
  if (it.frames.length > INTERP_BUFFER) it.frames.shift();
  const target = tick - nowMs / TICK_MS;
  if (it.offset === null || Math.abs(target - it.offset) > CLOCK_RESET_TICKS) {
    it.offset = target;
    it.lastRender = -Infinity;
  } else it.offset += (target - it.offset) * CLOCK_GAIN;
}

/** The server tick to draw others at, now: the estimate less DELAY_TICKS, never going backward. */
export function renderTick(it: Interp, nowMs: number): number {
  if (it.offset === null) return 0;
  const t = Math.max(it.lastRender, nowMs / TICK_MS + it.offset - DELAY_TICKS);
  it.lastRender = t;
  return t;
}

const find = (f: Frame, id: number) => {
  for (const row of f.p) if (row[0] === id) return row;
  return undefined;
};

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return a + d * t;
}

/**
 * Where a player is drawn: position, aim, and whether they are in a life, untouchable, dashing and
 * spawn-protected then, and their active pickups' bits (v7, #73). Past a snapshot, `dash` is the
 * next one's, so a dash shows from where it starts.
 */
export type Sampled = { x: number; y: number; aim: number; alive: boolean; inv: boolean; dash: boolean; prot: boolean; fx: number };

/**
 * Where player `id` is at server tick `at`, into `out`: between the two snapshots around it (aim
 * along the shorter arc), the oldest before the buffer, the newest when snapshots are late. False
 * when the newest snapshot doesn't have them: they left. Across a life ending or a respawn there
 * is no in-between: the earlier snapshot holds until the later one's tick, so a respawn never
 * slides across the map.
 */
export function sample(it: Interp, id: number, at: number, out: Sampled): boolean {
  const frames = it.frames;
  const n = frames.length;
  if (n === 0) return false;
  const newest = find(frames[n - 1]!, id);
  if (!newest) return false;
  let b = n - 1;
  while (b > 0 && frames[b - 1]!.tick > at) b--;
  // frames[b] is the first frame after `at` (or the newest); frames[b - 1] the one at or before.
  const fb = frames[b]!;
  const rb = find(fb, id) ?? newest;
  const fa = b > 0 ? frames[b - 1]! : null;
  const ra = fa ? find(fa, id) : undefined;
  if (!fa || !ra || at >= fb.tick) {
    out.x = rb[1];
    out.y = rb[2];
    out.aim = rb[5];
    out.alive = rb[6] === 1;
    out.inv = rb[7] === 1;
    out.dash = rb[8] === 1;
    out.prot = rb[9] === 1;
    out.fx = rb[10] ?? 0;
    return true;
  }
  if (ra[6] !== rb[6]) {
    out.x = ra[1];
    out.y = ra[2];
    out.aim = ra[5];
    out.alive = ra[6] === 1;
    out.inv = ra[7] === 1;
    out.dash = ra[8] === 1;
    out.prot = ra[9] === 1;
    out.fx = ra[10] ?? 0;
    return true;
  }
  const t = Math.min(1, Math.max(0, (at - fa.tick) / (fb.tick - fa.tick)));
  out.x = ra[1] + (rb[1] - ra[1]) * t;
  out.y = ra[2] + (rb[2] - ra[2]) * t;
  out.aim = lerpAngle(ra[5], rb[5], t);
  out.alive = ra[6] === 1;
  out.inv = ra[7] === 1;
  out.dash = (t > 0 ? rb : ra)[8] === 1;
  out.prot = ra[9] === 1;
  out.fx = ra[10] ?? 0;
  return true;
}

/**
 * The two snapshots to draw bugs from at tick `at`: `from` (the one at or before it, else the
 * oldest), `to` (the next, or null) and how far between (`t`). Draw `from`'s bugs, each moved
 * toward its row in `to.bi` (a bug missing there died: hold it), so a bug vanishes when it is seen
 * to die, not 100 ms early.
 */
export type BugSpan = { from: Frame | null; to: Frame | null; t: number };

export function bugSpan(it: Interp, at: number, span: BugSpan): BugSpan {
  const frames = it.frames;
  const n = frames.length;
  span.from = null;
  span.to = null;
  span.t = 0;
  if (n === 0) return span;
  let a = n - 1;
  while (a > 0 && frames[a]!.tick > at) a--;
  span.from = frames[a]!;
  const next = a + 1 < n ? frames[a + 1]! : null;
  if (next && at > span.from.tick) {
    span.to = next;
    span.t = Math.min(1, (at - span.from.tick) / (next.tick - span.from.tick));
  }
  return span;
}

const findDown = (f: Frame, id: number) => {
  for (const row of f.d) if (row[0] === id) return row;
  return undefined;
};

/**
 * Player `id`'s down row at tick `at`, from the frame `sample` draws them from (the one at or
 * before `at`, else the oldest), so a robot slumps on the same tick it is drawn hit. Undefined
 * when they are not down then.
 */
export function downAt(it: Interp, id: number, at: number): SnapshotDown | undefined {
  const frames = it.frames;
  let a = frames.length - 1;
  if (a < 0) return undefined;
  while (a > 0 && frames[a]!.tick > at) a--;
  return findDown(frames[a]!, id);
}

/** Player `id`'s down row in the newest snapshot (your own, drawn at the server's present). */
export function newestDown(it: Interp, id: number): SnapshotDown | undefined {
  const f = it.frames[it.frames.length - 1];
  return f ? findDown(f, id) : undefined;
}

/**
 * How long a bug's drawn heading takes to follow its direction of travel, seconds (#89). Bug
 * positions travel in whole units since protocol v11, so one tick's step points a few degrees off
 * (a walking crawler: p50 2.1, p95 5.6 degrees, against 0.2 and 0.6 at 0.1 units). Easing over
 * about a tick roughly halves that (p50 1.1, p95 3.3) and still shows a real turn within 0.1 s;
 * easing longer lags a spitter's or dasher's sharp turns by more than it smooths.
 */
export const HEADING_EASE_S = 0.06;

/**
 * A bug's heading after `dt` seconds of following `target` (its direction of travel) from `prev`,
 * the short way round; a bug seen for the first time (`prev` undefined) faces it at once.
 */
export function easeHeading(prev: number | undefined, target: number, dt: number): number {
  if (prev === undefined) return target;
  let d = target - prev;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return prev + d * (1 - Math.exp(-dt / HEADING_EASE_S));
}

/** The newest snapshot, for the ids and the minimap. */
export function newestPlayers(it: Interp): SnapshotPlayer[] {
  return it.frames[it.frames.length - 1]?.p ?? [];
}
