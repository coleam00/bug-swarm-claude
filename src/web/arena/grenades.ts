// Grenades on screen (#130): each `grenade` event, kept in a fixed pool of typed arrays so a frame
// allocates nothing, and where each is on the snapshot tick clock. The server sends only the throw;
// every page draws the same flight, blink and blast from it and the GRENADE_* numbers, a thrower's
// own at your clock (`mineAt`, where your kills land) and everyone else's at the others' (`rt`).
// Pure (no DOM, no canvas): game.ts steps it, draw/grenade.ts draws it.
import { GRENADE_FLIGHT_TICKS } from "../../shared/arena/constants";
import { GRENADE_FUSE_TICKS } from "../../shared/arena/grenade";

/** At most this many on screen at once (20 players, one each every 6 s, each about 1.3 s long). */
export const GRENADE_CAPACITY = 32;
/** The blast's flash lasts this long, ticks (0.3 s). */
export const GRENADE_FLASH_TICKS = 6;
/** Ticks from the throw's step to the blast's snapshot: the event's tick is the throw's snapshot (its step + 1). */
const BLAST_AT = GRENADE_FUSE_TICKS + 1;
const GONE_AT = BLAST_AT + GRENADE_FLASH_TICKS;

export type ClientGrenades = {
  owner: Int32Array;
  fromX: Float32Array;
  fromY: Float32Array;
  toX: Float32Array;
  toY: Float32Array;
  /** The tick of the throw's step (the event's tick less 1). */
  tick: Float64Array;
  /** 1 while in use. */
  on: Uint8Array;
  /** 1 once its blast has been shown. */
  blown: Uint8Array;
  live: number;
  /** The next slot to write, round-robin. */
  cursor: number;
};

export function createGrenades(capacity = GRENADE_CAPACITY): ClientGrenades {
  return {
    owner: new Int32Array(capacity),
    fromX: new Float32Array(capacity),
    fromY: new Float32Array(capacity),
    toX: new Float32Array(capacity),
    toY: new Float32Array(capacity),
    tick: new Float64Array(capacity),
    on: new Uint8Array(capacity),
    blown: new Uint8Array(capacity),
    live: 0,
    cursor: 0,
  };
}

/** Keeps a `grenade` event's throw (its `gr`); when the pool is full the oldest slot is overwritten. */
export function addGrenade(g: ClientGrenades, owner: number, gr: readonly [number, number, number, number, number]): void {
  const i = g.cursor;
  g.cursor = (i + 1) % g.on.length;
  if (!g.on[i]) g.live++;
  g.owner[i] = owner;
  g.fromX[i] = gr[0];
  g.fromY[i] = gr[1];
  g.toX[i] = gr[2];
  g.toY[i] = gr[3];
  g.tick[i] = gr[4] - 1;
  g.on[i] = 1;
  g.blown[i] = 0;
}

export function clearGrenades(g: ClientGrenades): void {
  g.on.fill(0);
  g.live = 0;
}

/** The clock grenade `i` is drawn at: your own at `mineAt`, everyone else's at `othersAt`. */
export function grenadeClock(g: ClientGrenades, i: number, you: number | null, mineAt: number, othersAt: number): number {
  return g.owner[i] === you ? mineAt : othersAt;
}

/**
 * Each frame: shows the blast of every grenade whose time has come, once (`onBlast` at its landing
 * point; one far past its blast, a page that was away, goes without), and frees those done.
 */
export function stepGrenadeFx(g: ClientGrenades, you: number | null, mineAt: number, othersAt: number, onBlast: (x: number, y: number) => void): void {
  if (g.live === 0) return;
  for (let i = 0; i < g.on.length; i++) {
    if (!g.on[i]) continue;
    const s = grenadeClock(g, i, you, mineAt, othersAt) - g.tick[i]!;
    if (s >= GONE_AT) {
      g.on[i] = 0;
      g.live--;
    } else if (s >= BLAST_AT && !g.blown[i]) {
      g.blown[i] = 1;
      onBlast(g.toX[i]!, g.toY[i]!);
    }
  }
}

/**
 * Where grenade `i` is at `clock`, into `out` (no allocation): `phase` 0 not yet thrown or gone, 1
 * flying (`k` 0 to 1 of the flight; x, y along the straight line, the drawing adds the arc), 2
 * blinking on the floor at its landing point (`k` 0 to 1 of the fuse left), 3 the blast's flash (`k`
 * 0 to 1 of it).
 */
export type GrenadeAt = { phase: 0 | 1 | 2 | 3; x: number; y: number; k: number };

export function grenadeAt(g: ClientGrenades, i: number, clock: number, out: GrenadeAt): GrenadeAt {
  out.phase = 0;
  if (!g.on[i]) return out;
  const s = clock - g.tick[i]!;
  if (s < 0 || s >= GONE_AT) return out;
  if (s < GRENADE_FLIGHT_TICKS) {
    const k = s / GRENADE_FLIGHT_TICKS;
    out.phase = 1;
    out.k = k;
    out.x = g.fromX[i]! + (g.toX[i]! - g.fromX[i]!) * k;
    out.y = g.fromY[i]! + (g.toY[i]! - g.fromY[i]!) * k;
    return out;
  }
  out.x = g.toX[i]!;
  out.y = g.toY[i]!;
  if (s < BLAST_AT) {
    out.phase = 2;
    out.k = (s - GRENADE_FLIGHT_TICKS) / (BLAST_AT - GRENADE_FLIGHT_TICKS);
  } else {
    out.phase = 3;
    out.k = (s - BLAST_AT) / GRENADE_FLASH_TICKS;
  }
  return out;
}
