import { describe, expect, test } from "bun:test";
import { DOWN_TICKS, MAX_CLIENT_MESSAGE_BYTES } from "./constants";
import {
  CLIENT_TYPES,
  EVENT,
  QUEEN,
  SERVER_TYPES,
  type ArenaEvent,
  type SharedSource,
  type Snapshot,
  encodeHello,
  encodeInput,
  encodeSnapshot,
  encodeSnapshotPlayers,
  encodeSnapshotShared,
  encodeWatch,
  parseClientMessage,
  parseServerMessage,
  utf8Bytes,
} from "./protocol";

const PLAYER = "0123456789abcdef0123456789abcdef";
const hello = { t: "hello", v: 1, name: "Robo", team: "tabs", player: PLAYER, touch: false, build: "" };
const input = { t: "input", seq: 5, mx: 0.5, my: -1, aim: 1.25, fire: false, dash: true };
const s = (m: unknown) => JSON.stringify(m);
/** A watcher's numbers: nothing of its own. */
const ME0 = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0 as const, hl: 0, al: 0 as const, dk: 0, dc: 0, dn: 0 as const, fx: [] };
/** A player row's down fields while not down. */
const UP = { down: false, downTick: 0, reviver: 0, reviveTicks: 0, effect: [0, 0] };

/** A valid hello padded with an ignored field to exactly `bytes` UTF-8 bytes. */
function helloOf(bytes: number, pad = "x"): string {
  const base = s({ ...hello, pad: "" });
  return s({ ...hello, pad: pad.repeat((bytes - utf8Bytes(base)) / utf8Bytes(pad)) });
}

describe("parseClientMessage", () => {
  test("valid hello and input parse to their fields", () => {
    expect(parseClientMessage(s(hello))).toEqual(hello as never);
    expect(parseClientMessage(s(input))).toEqual(input as never);
    expect(parseClientMessage(encodeHello(1, "Robo", "tabs", PLAYER, false))).toEqual(hello as never);
    expect(parseClientMessage(encodeInput({ seq: 5, mx: 0.5, my: -1, aim: 1.25, fire: false, dash: true }))).toEqual(input as never);
  });

  test("a hello's build is optional (a first join, an older page) and capped", () => {
    const { build: _, ...noBuild } = hello;
    expect(parseClientMessage(s(noBuild))).toEqual(hello as never);
    expect(parseClientMessage(encodeHello(1, "Robo", "tabs", PLAYER, false, "abc"))).toEqual({ ...hello, build: "abc" } as never);
    expect(parseClientMessage(s({ ...hello, build: 7 }))).toBeNull();
    expect(parseClientMessage(s({ ...hello, build: "x".repeat(65) }))).toBeNull();
  });

  test("a watch (v8) parses to its version; a missing or fractional version drops it; extra fields are ignored", () => {
    expect(parseClientMessage(encodeWatch(8))).toEqual({ t: "watch", v: 8 });
    expect(parseClientMessage(s({ t: "watch", v: 3, name: "x" }))).toEqual({ t: "watch", v: 3 });
    expect(parseClientMessage(s({ t: "watch" }))).toBeNull();
    expect(parseClientMessage(s({ t: "watch", v: 1.5 }))).toBeNull();
    expect(parseClientMessage(s({ t: "watch", v: "8" }))).toBeNull();
  });

  test("a version mismatch still parses: the server decides", () => {
    expect(parseClientMessage(s({ ...hello, v: 2 }))).toMatchObject({ t: "hello", v: 2 });
  });

  test("unknown types, bad JSON and non-objects are dropped", () => {
    for (const raw of [
      s({ ...input, t: "snapshot" }),
      s({ ...input, t: undefined }),
      "{",
      "",
      "null",
      "42",
      '"input"',
      s([input]),
      s({ ...input, t: "over" }),
    ]) {
      expect(parseClientMessage(raw)).toBeNull();
    }
  });

  test("a missing or wrong-typed field is dropped", () => {
    for (const key of Object.keys(input)) {
      if (key === "t") continue;
      const missing: Record<string, unknown> = { ...input };
      delete missing[key];
      expect(parseClientMessage(s(missing))).toBeNull();
      expect(parseClientMessage(s({ ...input, [key]: "1" }))).toBeNull();
      expect(parseClientMessage(s({ ...input, [key]: { nested: [1, 2] } }))).toBeNull();
    }
    for (const key of Object.keys(hello)) {
      // build is optional (its own test above).
      if (key === "t" || key === "build") continue;
      const missing: Record<string, unknown> = { ...hello };
      delete missing[key];
      expect(parseClientMessage(s(missing))).toBeNull();
      expect(parseClientMessage(s({ ...hello, [key]: [] }))).toBeNull();
    }
  });

  test("non-finite and out-of-range numbers are dropped", () => {
    expect(parseClientMessage(s({ ...input, mx: "NaN" }))).toBeNull();
    expect(parseClientMessage('{"t":"input","seq":1,"mx":NaN,"my":0,"aim":0,"fire":false,"dash":false}')).toBeNull();
    expect(parseClientMessage('{"t":"input","seq":1,"mx":1e999,"my":0,"aim":0,"fire":false,"dash":false}')).toBeNull();
    expect(parseClientMessage(s({ ...input, seq: -1 }))).toBeNull();
    expect(parseClientMessage(s({ ...input, seq: 1.5 }))).toBeNull();
    expect(parseClientMessage(s({ ...input, seq: 2 ** 31 }))).toBeNull();
    expect(parseClientMessage(s({ ...input, seq: 2 ** 31 - 1 }))).not.toBeNull();
    expect(parseClientMessage(s({ ...hello, v: 1.5 }))).toBeNull();
  });

  test("a hello with a long name or a malformed player id is dropped", () => {
    expect(parseClientMessage(s({ ...hello, name: "a".repeat(65) }))).toBeNull();
    expect(parseClientMessage(s({ ...hello, name: "a".repeat(64) }))).not.toBeNull();
    expect(parseClientMessage(s({ ...hello, player: "nope" }))).toBeNull();
    expect(parseClientMessage(s({ ...hello, player: PLAYER.toUpperCase() }))).toBeNull();
  });

  test("binary frames are dropped", () => {
    const bytes = new TextEncoder().encode(s(input));
    expect(parseClientMessage(bytes)).toBeNull();
    expect(parseClientMessage(bytes.buffer as ArrayBuffer)).toBeNull();
  });

  test("exactly 1024 bytes passes; 1025 is dropped, counted in UTF-8 bytes", () => {
    expect(utf8Bytes(helloOf(MAX_CLIENT_MESSAGE_BYTES))).toBe(1024);
    expect(parseClientMessage(helloOf(MAX_CLIENT_MESSAGE_BYTES))).not.toBeNull();
    expect(parseClientMessage(helloOf(MAX_CLIENT_MESSAGE_BYTES + 1))).toBeNull();
    // 2-byte characters: 512 UTF-16 units short of the limit, but over it in bytes.
    const wide = helloOf(1026, "é");
    expect(wide.length).toBeLessThan(1024);
    expect(parseClientMessage(wide)).toBeNull();
  });

  test("utf8Bytes matches TextEncoder", () => {
    for (const str of ["", "abc", "é", "日本", "😀", "a😀b", "\ud800x"]) {
      expect(utf8Bytes(str)).toBe(new TextEncoder().encode(str).length);
    }
  });
});

describe("server messages", () => {
  test("a snapshot is built from a shared part and your own numbers, and round-trips, quantized", () => {
    const players = [
      { id: 1, x: 10.123456, y: 20.5, vx: -3.004, vy: 0, aim: 1.23456, alive: true, invulnTicks: 3, dashTicks: 0, protectTicks: 0, ...UP },
      // A shield (bit 0) and a laser (bit 1) on: effects 3.
      { id: 2, x: 2386, y: 14, vx: 300, vy: -299.999, aim: -3.14159, alive: true, invulnTicks: 0, dashTicks: 2, protectTicks: 12, ...UP, effect: [5, 160] },
      // Out of a life: no effects shown, whatever is left in the array.
      { id: 3, x: 5, y: 5, vx: 0, vy: 0, aim: 0, alive: false, invulnTicks: 9, dashTicks: 1, protectTicks: 9, ...UP, effect: [0, 9] },
      // Down: went down in the step before the snapshot of tick 9 (so one tick of DOWN_S has gone),
      // with player 1 holding 13 of 40 steps of revive progress.
      { id: 4, x: 50, y: 50, vx: 0, vy: 0, aim: 0, alive: true, invulnTicks: 0, dashTicks: 0, protectTicks: 0, down: true, downTick: 8, reviver: 1, reviveTicks: 13, effect: [0, 0] },
      // Down for its whole DOWN_S: never shows below 0.
      { id: 5, x: 60, y: 50, vx: 0, vy: 0, aim: 0, alive: true, invulnTicks: 0, dashTicks: 0, protectTicks: 0, down: true, downTick: 9 - DOWN_TICKS - 1, reviver: 0, reviveTicks: 0, effect: [0, 0] },
    ];
    const src = {
      tick: 9,
      players,
      // Phase 0 (every crawler): four fields. Any other phase adds phase, angle and ticks in it.
      bugs: [
        { id: 7, kind: "crawler", x: 100.04, y: 200.06, hp: 1, phase: 0, phaseTicks: 9, dx: 1, dy: 0 },
        { id: 8, kind: "other", x: 300, y: 400, hp: 2, phase: 2, phaseTicks: 5, dx: 0, dy: -1 },
      ],
      floor: [
        { id: 3, kind: "laser", x: 1000.04, y: 12.36, ticksLeft: 240 },
        { id: 4, kind: "shield", x: 5, y: 6, ticksLeft: 1 },
      ],
      queen: { stage: 0, x: 0, y: 0, ticksLeft: 0, bugId: 0, maxHp: 0 },
      events: {
        shotsFired: [
          { id: 11, owner: 1, x: 30.123, y: 20.5, angle: 0.12345, laser: false, drone: false },
          { id: 12, owner: 2, x: 1, y: 2, angle: 3, laser: true, drone: false },
          // A CI drone's shot (v10, #84): style 2.
          { id: 13, owner: 1, x: 40, y: 22, angle: -1, laser: false, drone: true },
        ],
        shotsEnded: [
          { id: 10, hit: true, blocked: false, travelled: 123.456 },
          { id: 9, hit: false, blocked: false, travelled: 700 },
          { id: 13, hit: true, blocked: true, travelled: 40 },
        ],
        kills: [
          { bug: 6, by: 2, x: 50.06, y: 60, points: 15, kind: "crawler" },
          { bug: 5, by: 0, x: 1, y: 2, points: 0, kind: "other" },
        ],
      },
    };
    const shared = encodeSnapshotShared(src, ["crawler", "other"], 3, ["shield", "laser"]);
    const me = { sc: 120, ki: 9, st: 6, mu: 1.5, he: 0.4567, lk: 0 as const, hl: 2, al: 1 as const, dk: 2, dc: 28, dn: 0 as const, fx: [0, 37] };
    expect(shared.startsWith(`"p":${encodeSnapshotPlayers(players)},`)).toBe(true);
    const msg = parseServerMessage(encodeSnapshot(9, 4, me, shared));
    expect(msg).toEqual({
      t: "snapshot",
      tick: 9,
      ack: 4,
      me: { ...me, he: 0.46 },
      p: [
        [1, 10.12, 20.5, -3, 0, 1.235, 1, 1, 0, 0, 0],
        [2, 2386, 14, 300, -300, -3.142, 1, 0, 1, 1, 3],
        [3, 5, 5, 0, 0, 0, 0, 0, 0, 0, 0],
        [4, 50, 50, 0, 0, 0, 1, 0, 0, 0, 0],
        [5, 60, 50, 0, 0, 0, 1, 0, 0, 0, 0],
      ],
      b: [
        [7, 0, 100, 200.1],
        [8, 1, 300, 400, 2, -1.57, 5],
      ],
      s: [
        [11, 1, 30.12, 20.5, 0.123, 0],
        [12, 2, 1, 2, 3, 1],
        [13, 1, 40, 22, -1, 2],
      ],
      e: [
        [10, 1, 123.5],
        [9, 0, 700],
        [13, 2, 40],
      ],
      k: [
        [6, 2, 50.1, 60, 15, 0],
        [5, 0, 1, 2, 0, 1],
      ],
      d: [
        [4, 9.95, 1, 0.33],
        [5, 0, 0, 0],
      ],
      f: [
        [3, 1, 1000, 12.4, 240],
        [4, 0, 5, 6, 1],
      ],
      q: [],
      w: 3,
    });
    // Nobody down: an empty list; and `dn` in your numbers.
    const none = encodeSnapshotShared({ ...src, players: players.slice(0, 3), floor: [] }, ["crawler", "other"], 3, ["shield", "laser"]);
    expect(none).toContain(`"d":[],"f":[],"q":[],"w":3`);
    expect(parseServerMessage(encodeSnapshot(9, 4, { ...me, hl: 0, dn: 1 }, none))).toMatchObject({ me: { hl: 0, dn: 1 }, d: [] });
  });

  test("v11: the hive queen's marker, then her health, travel in `q` (#85)", () => {
    const base = { tick: 1, players: [], floor: [], events: { shotsFired: [], shotsEnded: [], kills: [] } };
    const bugs = [{ id: 40, kind: "other", x: 1200.04, y: 900.06, hp: 77, phase: 0, phaseTicks: 0, dx: 1, dy: 0 }];
    const q = (queen: SharedSource["queen"]) => (parseServerMessage(encodeSnapshot(1, 0, ME0, encodeSnapshotShared({ ...base, bugs, queen }, ["crawler", "other"], 5, []))) as Snapshot).q;
    expect(q({ stage: 0, x: 0, y: 0, ticksLeft: 0, bugId: 0, maxHp: 0 })).toEqual([]);
    expect(q({ stage: 1, x: 1500, y: 600.04, ticksLeft: 23, bugId: 0, maxHp: 0 })).toEqual([0, 1500, 600, 23]);
    expect(q({ stage: 2, x: 1200, y: 900, ticksLeft: 0, bugId: 40, maxHp: 120 })).toEqual([1, 40, 1200, 900.1, 77, 120]);
    // Her row is in `b` as any bug's; a stage with no bug of hers sends nothing.
    expect(q({ stage: 2, x: 1200, y: 900, ticksLeft: 0, bugId: 41, maxHp: 120 })).toEqual([]);
  });

  test("v11: a `queen` event names the top dealer and every reward", () => {
    const ev: ArenaEvent = { t: EVENT, kind: QUEEN, id: 3, paid: [[3, 475], [5, 275]] };
    expect(parseServerMessage(JSON.stringify(ev))).toEqual(ev);
  });

  test("parseServerMessage accepts only known types", () => {
    for (const t of SERVER_TYPES) expect(parseServerMessage(s({ t }))).toEqual({ t } as never);
    for (const t of CLIENT_TYPES) expect(parseServerMessage(s({ t }))).toBeNull();
    expect(parseServerMessage("{")).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});
