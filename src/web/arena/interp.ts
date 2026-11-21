// Interpolation of everyone else: the last few snapshots, and an estimate of the server's tick
// from when they arrived, so other players are drawn INTERP_DELAY_MS behind the server, between
// two snapshots, and move smoothly at any frame rate. Pure: the frame time comes in as a number.
import { INTERP_DELAY_MS, TICK_MS } from "../../shared/arena/constants";
import type { SnapshotPlayer } from "../../shared/arena/protocol";

/** Snapshots kept: half a second at 20 Hz. */
export const INTERP_BUFFER = 10;
/** How much of each new arrival the tick clock takes (smooths network jitter). */
export const CLOCK_GAIN = 0.1;
/** A clock this many ticks off is reset, not smoothed (a tab back from the background). */
export const CLOCK_RESET_TICKS = 5;
/** How far behind the server's tick other players are drawn, in ticks. */
export const DELAY_TICKS = INTERP_DELAY_MS / TICK_MS;

type Frame = { tick: number; p: SnapshotPlayer[] };

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
export function pushSnapshot(it: Interp, tick: number, players: SnapshotPlayer[], nowMs: number): void {
  const newest = it.frames[it.frames.length - 1];
  if (newest && tick <= newest.tick) return;
  it.frames.push({ tick, p: players });
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
 * Where player `id` is at server tick `at`, into `out`: between the two snapshots around it (aim
 * along the shorter arc), the oldest before the buffer, the newest when snapshots are late. False
 * when the newest snapshot doesn't have them: they left.
 */
export function sample(it: Interp, id: number, at: number, out: { x: number; y: number; aim: number }): boolean {
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
    return true;
  }
  const t = Math.min(1, Math.max(0, (at - fa.tick) / (fb.tick - fa.tick)));
  out.x = ra[1] + (rb[1] - ra[1]) * t;
  out.y = ra[2] + (rb[2] - ra[2]) * t;
  out.aim = lerpAngle(ra[5], rb[5], t);
  return true;
}

/** The newest snapshot, for the ids and the minimap. */
export function newestPlayers(it: Interp): SnapshotPlayer[] {
  return it.frames[it.frames.length - 1]?.p ?? [];
}
