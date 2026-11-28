// The arena's WebSocket protocol (release 2): JSON text frames, each an object whose `t` names
// its type. One validator, `parseClientMessage`, is the only way the server reads a client
// message: anything malformed, unknown or over MAX_CLIENT_MESSAGE_BYTES is dropped (null). The
// validator rejects junk only; the simulation still clamps what it accepts (sim.ts clampInput).
import { MAX_CLIENT_MESSAGE_BYTES } from "./constants";

/** Client to server. */
export const CLIENT_TYPES = ["hello", "input", "watch", "visibility"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];
export const [HELLO, INPUT, WATCH, VISIBILITY] = CLIENT_TYPES;

/** Server to client. */
export const SERVER_TYPES = ["welcome", "snapshot", "event", "error"] as const;
export type ServerType = (typeof SERVER_TYPES)[number];
export const [WELCOME, SNAPSHOT, EVENT, ERROR] = SERVER_TYPES;

/**
 * What an `event` reports: a join, a leave, your life being over (sent to you only), a player
 * going down, a revive (who, by whom, the points; both v4), a pickup taken (who, and the pickup's
 * index in PICKUP_IDS), a test shield blocking a hit (whose; both v7) and a hive queen killed (v12,
 * #85: `id` the top damage dealer, 0 for none, and `paid` each rewarded player's id and points) and
 * a golden bug killed (v13, #122: `id` the killer, for the banner every page in the arena shows) and
 * a grenade thrown (v14, #130: `id` the thrower and `gr` its flight, so every page draws the same
 * flight, blink ring and blast from the GRENADE_* numbers).
 * Hits, kills and shots travel in snapshots, and so do who is down now (`d`), the pickups on the
 * floor (`f`) and the hive queen's marker or health (`q`), for a late joiner.
 */
export const EVENT_KINDS = ["join", "leave", "over", "down", "revive", "pickup", "block", "queen", "golden", "grenade"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const [JOIN, LEAVE, OVER, DOWN, REVIVE, PICKUP, BLOCK, QUEEN, GOLDEN, GRENADE] = EVENT_KINDS;

/**
 * Why the server closed the socket: a refused hello (version, name, team, no hello in time, or a
 * rejoin from a page of another build: reload), the server stopping for a redeploy (restarting:
 * reconnect), a watch refused because the server has MAX_WATCHERS watching already, or the client's address
 * MAX_WATCHERS_PER_ADDRESS (full, v8; the per-address cap, #119, without a version bump), too
 * many sockets or joins from the client's address (limit: MAX_SOCKETS_PER_ADDRESS,
 * JOINS_PER_ADDRESS_PER_MINUTE) or a hello refused because MAX_PEOPLE are playing (busy). The
 * socket closes after each. limit and busy (#104) came without a protocol version bump: a page
 * from before them passes an unknown code through, the close follows, and it rejoins with backoff.
 */
export const ERROR_CODES = ["version", "name", "team", "hello", "restarting", "build", "full", "limit", "busy"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export const [ERROR_VERSION, ERROR_NAME, ERROR_TEAM, ERROR_HELLO, ERROR_RESTARTING, ERROR_BUILD, ERROR_FULL, ERROR_LIMIT, ERROR_BUSY] = ERROR_CODES;

/** The longest name a hello may carry before the server's name rules (rules.ts) even look at it. */
export const HELLO_NAME_MAX = 64;
/** The largest input sequence number. */
export const MAX_SEQ = 2 ** 31 - 1;
const PLAYER_ID = /^[0-9a-f]{32}$/;

export type Hello = {
  t: typeof HELLO;
  /** PROTOCOL_VERSION the client speaks. Any whole number parses; the server decides. */
  v: number;
  name: string;
  /** Checked against TEAMS by the server. */
  team: string;
  /** The browser's 32-hex player id (player.ts). Never sent to other players. */
  player: string;
  touch: boolean;
  /**
   * The build id of the page's first welcome, on a rejoin ("" on a first join, or when absent): a
   * server of another build refuses it with `build` before it joins, so no life is started.
   */
  build: string;
};

export type InputMessage = {
  t: typeof INPUT;
  seq: number;
  mx: number;
  my: number;
  aim: number;
  fire: boolean;
  dash: boolean;
  /** A grenade press (v13, #130), edge-triggered like the dash; never the respawn. */
  grenade: boolean;
};

/**
 * A spectator (v8, #79): the start screen asks to watch an arena instead of saying hello. A
 * watcher takes no player slot and sends no inputs; it gets a welcome with `you: 0` and the
 * arena's events and snapshots (`ack` 0, `me` zeroed). A hello on a watching socket turns it into
 * a player on the same socket.
 */
export type Watch = { t: typeof WATCH; v: number };

/**
 * Whether the player's tab is hidden (#117): sent on every change and after a player welcome on a
 * hidden page. A hidden player does not count as a person (Room.people). It came without a protocol
 * version bump: an older server drops the unknown type, and an older page never sends it.
 */
export type Visibility = { t: typeof VISIBILITY; hidden: boolean };

export type ClientMessage = Hello | InputMessage | Watch | Visibility;

export type RosterEntry = { id: number; name: string; team: string };

export type Welcome = {
  t: typeof WELCOME;
  v: number;
  /** Your entity id; 0 on a watching socket (player ids start at 1). */
  you: number;
  arena: number;
  build: string;
  world: { w: number; h: number };
  tickMs: number;
  tick: number;
  /** Everyone in the arena, you included. Later joins and leaves come as events. */
  roster: RosterEntry[];
};

/**
 * One player in a snapshot: id, x, y, vx, vy, aim, alive (0/1), untouchable after a hit or a
 * revive (0/1), dashing (0/1, v3), spawn-protected (0/1, v5, #58), effects (v7, #73: bit i set
 * while the pickup PICKUP_IDS[i] is active on a player in a life, so everyone sees a shield bubble
 * or a laser). Since v11 (#89) positions to 0.1 and aim to 0.01, and vx and vy are 0 on every row
 * but your own (exact, from `me`). Fields are only ever appended, never
 * reordered.
 */
export type SnapshotPlayer = [
  id: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  aim: number,
  alive: 0 | 1,
  invulnerable: 0 | 1,
  dashing: 0 | 1,
  spawnProtected: 0 | 1,
  effects: number,
];
/**
 * One bug: id, its kind's index in BUG_KINDS, x, y (whole units since v11). v6: a bug whose phase is not 0 (its
 * kind's first) adds a tail: phase (an index into its kind's phases), angle (its locked
 * direction, radians to 0.01) and ticksIn (ticks spent in that phase). A bug in phase 0, every
 * crawler for one, costs no more bytes than before.
 */
export type SnapshotBug = [id: number, kind: number, x: number, y: number] | [id: number, kind: number, x: number, y: number, phase: number, angle: number, ticksIn: number];
/**
 * A shot fired this tick: id, owner, where it left the barrel (to 0.1; a CI drone's shot: the drone),
 * its angle (to 0.001), and its style: the gun's (0), a review laser shot (1, v7) or a CI drone's (2,
 * v10, #84). It flies per shotTravelAt.
 */
export type SnapshotShot = [id: number, owner: number, x: number, y: number, angle: number, style: ShotStyle];
/** A shot's style on the wire (v10): the field was 0 or 1 for laser in v7 to v9. */
export const SHOT_GUN = 0;
export const SHOT_LASER = 1;
export const SHOT_DRONE = 2;
export type ShotStyle = typeof SHOT_GUN | typeof SHOT_LASER | typeof SHOT_DRONE;
/**
 * A shot ended this tick: id, ended on a bug (1), on a bug's shell, doing no damage (2, v8, #80), or
 * at its range or a wall (0; a review laser shot may have hit bugs on the way, v7), units flown
 * from the barrel (to 0.1).
 */
export type SnapshotShotEnd = [id: number, hit: 0 | 1 | 2, travelled: number];
/** A bug killed this tick: bug id, by (0: nobody scores), x, y, points, its kind's index in BUG_KINDS (v6). */
export type SnapshotKill = [bug: number, by: number, x: number, y: number, points: number, kind: number];
/**
 * A downed player (v4): id, seconds left before bleeding out (to 0.01), the player holding revive
 * progress (0: none), and that progress, 0 to 1 (to 0.01). Only downed players have a row.
 */
export type SnapshotDown = [id: number, secondsLeft: number, reviver: number, progress: number];
/** A pickup on the floor (v7, #73): id, its index in PICKUP_IDS, x, y (to 0.1), ticks before it goes. */
export type SnapshotPickup = [id: number, pickup: number, x: number, y: number, ticksLeft: number];
/**
 * The hive queen (v12, #85), decoded: empty with none; her marker while she arrives (stage 0: x, y,
 * ticks before she appears); or her alive (stage 1: her bug id, x, y, hit points left and at the
 * start). Every recipient gets it, never culled to the view, so her arrow, minimap mark and health
 * bar never depend on which bugs a snapshot carries. On the wire the marker carries the tick she
 * appears instead of the ticks left, and positions are whole units.
 */
export type SnapshotQueen = [] | [stage: 0, x: number, y: number, ticksLeft: number] | [stage: 1, id: number, x: number, y: number, hp: number, maxHp: number];
/**
 * The golden bug (v13, #122): empty with none alive, else its bug id and where it is (whole units).
 * Every recipient gets it, never culled to the view, so its gold minimap dot and edge arrow show
 * wherever it runs.
 */
export type SnapshotGolden = [] | [id: number, x: number, y: number];

/** Your own numbers, in your snapshots only. */
export type SnapshotMe = {
  /** Score, kills, hits in a row and its multiplier, this life. */
  sc: number;
  ki: number;
  st: number;
  mu: number;
  /** Gun heat, 0 to 1 (to 0.01), and whether the gun is locked (0/1). */
  he: number;
  lk: 0 | 1;
  /** Hits left this life. */
  hl: number;
  /** In a life (1) or out (0). Still 1 while down. */
  al: 0 | 1;
  /** Dash ticks left (above 0: dashing) and ticks until a dash press is accepted (v3). */
  dk: number;
  dc: number;
  /** Down (1): waiting for a revive (v4). */
  dn: 0 | 1;
  /** Ticks until a grenade press is accepted (v13, #130). */
  gc: number;
  /** Ticks left of each pickup's effect, by its index in PICKUP_IDS (0: not active; v7). */
  fx: number[];
  /**
   * Your robot's position and velocity to 0.01 (v11, #89): the `p` rows carry positions to 0.1
   * and no velocities, and prediction reconciles against these. The decoded self row has them.
   */
  x: number;
  y: number;
  vx: number;
  vy: number;
};

/**
 * A snapshot as the browser and the bots use it, decoded from the wire by view.ts (v11, #89): the
 * same shape every version had. Positions are as quantized on the wire (players to 0.1, bugs to
 * whole units), other players' vx and vy are 0, and your own row carries `me`'s exact numbers.
 */
export type Snapshot = {
  t: typeof SNAPSHOT;
  tick: number;
  /** The last input sequence number the server applied for you (0 before any). */
  ack: number;
  /** Every player in the arena (at most 20), so the minimap shows everyone. */
  p: SnapshotPlayer[];
  /** The bugs in your view square plus CULL_MARGIN (every bug when watching). */
  b: SnapshotBug[];
  /** Shots fired, shots ended and bugs killed in this tick that you could see. */
  s: SnapshotShot[];
  e: SnapshotShotEnd[];
  k: SnapshotKill[];
  /** Every downed player now. */
  d: SnapshotDown[];
  /** The pickups on the floor in your view square (at most MAX_PICKUPS_PER_ARENA; v7). */
  f: SnapshotPickup[];
  /** The arena's wave. */
  w: number;
  /** The hive queen's marker or health (v12, #85), never culled. */
  q: SnapshotQueen;
  /** The golden bug (v13, #122), never culled. */
  g: SnapshotGolden;
  me: SnapshotMe;
  /**
   * On keyframes only (v11): every bug outside your view square, globs left out, as minimap cells
   * `[cx0, cy0, cx1, cy1, ...]`, each round(x / MINIMAP_CELL). Absent on deltas and when watching.
   */
  m?: number[];
};

/**
 * A snapshot as it travels (v11, #89; view.ts writes and reads it). A keyframe (`key: 1`) is whole:
 * - `you`: the recipient's entity id (0 watching);
 * - `p`: every player, `[id, x10, y10, aim100, flags, effects]` (x10 = round(x * 10), aim100 =
 *   round(aim * 100); flags: 1 alive, 2 untouchable, 4 dashing, 8 spawn-protected);
 * - `b`: the bugs in view, `[id, kind, x, y]` in whole units, a bug out of phase 0 adding
 *   `phase, angle100, ticksIn`;
 * - `f`: the pickups in view, `[id, pickup, x10, y10, goneTick]`;
 * - `d`: every downed player, `[id, downTick, reviver, progress100]`;
 * - `w`, `me` (every key) and `m` (the minimap's far bugs);
 * - `q` (v12, #85): the hive queen, `[]`, `[0, x, y, appearTick]` or `[1, id, x, y, hp, maxHp]`,
 *   never culled.
 *
 * A delta (`base`: the tick of the previous snapshot this recipient was sent) changes the
 * receiver's copy of that snapshot, in this order: `gb` the mirror indices of bugs gone; `b` a flat
 * `dx, dy` per remaining bug in mirror order, plus `dangle100, dticksIn` for each whose mirror row
 * has a tail (0, 0 when `bt` replaces it); `bt` `[index, phase, angle100, ticksIn]` for a new tail
 * (`[index, 0]` drops it); `nb` new bug rows, appended. Players the same way: `gp`, `p` (flat
 * `dx10, dy10, daim100`), `pf` `[index, flags, effects]`, `np`. Pickups: `gf` gone ids, `nf` new
 * rows. `d`, `w` and `q` only when they changed; `me` only its changed keys. A field with nothing in it
 * is left out. `s`, `e` and `k` (this tick's events, culled to the view) are on every snapshot.
 */
export type WireSnapshot = {
  t: typeof SNAPSHOT;
  tick: number;
  ack: number;
  key?: 1;
  you?: number;
  base?: number;
  p?: number[] | number[][];
  b?: number[] | number[][];
  f?: number[][];
  d?: number[][];
  w?: number;
  q?: number[];
  g?: number[];
  me?: Partial<SnapshotMe>;
  m?: number[];
  gb?: number[];
  bt?: number[][];
  nb?: number[][];
  gp?: number[];
  pf?: number[][];
  np?: number[][];
  gf?: number[];
  nf?: number[][];
  s?: SnapshotShot[];
  e?: SnapshotShotEnd[];
  k?: SnapshotKill[];
};

export type ArenaEvent = {
  t: typeof EVENT;
  kind: EventKind;
  id: number;
  name?: string;
  team?: string;
  /** With "revive": the reviver. */
  by?: number;
  /** With "revive": the points it scored. */
  points?: number;
  /** With "pickup": the pickup's index in PICKUP_IDS (v7). */
  pickup?: number;
  /** With "queen" (v12): each rewarded player's id and points. */
  paid?: [id: number, points: number][];
  /**
   * With "grenade" (v13, #130): where it was thrown from and lands (to 0.1), and the tick of the
   * snapshot after its throw's step; it goes off in the step whose snapshot is that tick plus
   * GRENADE_FUSE_TICKS.
   */
  gr?: [fromX: number, fromY: number, toX: number, toY: number, tick: number];
  /** With "over": the life's score, kills and length. */
  score?: number;
  kills?: number;
  seconds?: number;
};

/** With code `build`: the server's build id. */
export type ErrorMessage = { t: typeof ERROR; code: ErrorCode; build?: string };

/** A server message as the browser and the bots handle it, its snapshot decoded (view.ts). */
export type ServerMessage = Welcome | Snapshot | ArenaEvent | ErrorMessage;
/** A server message as it travels. */
export type WireMessage = Welcome | WireSnapshot | ArenaEvent | ErrorMessage;

/** UTF-8 length of a string, without allocating. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Reads one client message, or null when it must be dropped: binary, over
 * MAX_CLIENT_MESSAGE_BYTES UTF-8 bytes, not JSON, not an object, an unknown `t`, or a field
 * missing, of the wrong type or not finite. Extra fields are ignored.
 */
export function parseClientMessage(raw: string | ArrayBuffer | Uint8Array): ClientMessage | null {
  if (typeof raw !== "string") return null;
  // UTF-8 is never shorter than UTF-16 code units, so this skips counting a huge message.
  if (raw.length > MAX_CLIENT_MESSAGE_BYTES || utf8Bytes(raw) > MAX_CLIENT_MESSAGE_BYTES) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(m)) return null;
  if (m.t === INPUT) {
    const { seq, mx, my, aim, fire, dash, grenade } = m;
    if (!Number.isInteger(seq) || (seq as number) < 0 || (seq as number) > MAX_SEQ) return null;
    if (!finite(mx) || !finite(my) || !finite(aim)) return null;
    if (typeof fire !== "boolean" || typeof dash !== "boolean" || typeof grenade !== "boolean") return null;
    return { t: INPUT, seq: seq as number, mx, my, aim, fire, dash, grenade };
  }
  if (m.t === HELLO) {
    const { v, name, team, player, touch, build = "" } = m;
    if (!Number.isInteger(v)) return null;
    if (typeof name !== "string" || name.length > HELLO_NAME_MAX) return null;
    if (typeof team !== "string" || team.length > HELLO_NAME_MAX) return null;
    if (typeof player !== "string" || !PLAYER_ID.test(player)) return null;
    if (typeof touch !== "boolean") return null;
    if (typeof build !== "string" || build.length > HELLO_NAME_MAX) return null;
    return { t: HELLO, v: v as number, name, team, player, touch, build };
  }
  if (m.t === WATCH) {
    if (!Number.isInteger(m.v)) return null;
    return { t: WATCH, v: m.v as number };
  }
  if (m.t === VISIBILITY) {
    if (typeof m.hidden !== "boolean") return null;
    return { t: VISIBILITY, hidden: m.hidden };
  }
  return null;
}

/**
 * Reads one server message in the browser, or null if it is not one. The server is trusted, so
 * this checks only that it is an object with a known `t`. A snapshot still needs decoding
 * (view.ts createSnapshotReader).
 */
export function parseServerMessage(raw: unknown): WireMessage | null {
  if (typeof raw !== "string") return null;
  try {
    const m: unknown = JSON.parse(raw);
    return isRecord(m) && (SERVER_TYPES as readonly unknown[]).includes(m.t) ? (m as WireMessage) : null;
  } catch {
    return null;
  }
}

export function encodeHello(v: number, name: string, team: string, player: string, touch: boolean, build = ""): string {
  const m: Hello = { t: HELLO, v, name, team, player, touch, build };
  return JSON.stringify(m);
}

export function encodeWatch(v: number): string {
  const m: Watch = { t: WATCH, v };
  return JSON.stringify(m);
}

export function encodeVisibility(hidden: boolean): string {
  const m: Visibility = { t: VISIBILITY, hidden };
  return JSON.stringify(m);
}

/** An input, unrounded: the browser predicts with exactly the numbers the server will step. */
export function encodeInput(i: Omit<InputMessage, "t">): string {
  const m: InputMessage = { t: INPUT, seq: i.seq, mx: i.mx, my: i.my, aim: i.aim, fire: i.fire, dash: i.dash, grenade: i.grenade };
  return JSON.stringify(m);
}
