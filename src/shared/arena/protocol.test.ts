import { describe, expect, test } from "bun:test";
import { MAX_CLIENT_MESSAGE_BYTES } from "./constants";
import {
  CLIENT_TYPES,
  SERVER_TYPES,
  encodeHello,
  encodeInput,
  encodeSnapshot,
  encodeSnapshotPlayers,
  parseClientMessage,
  parseServerMessage,
  utf8Bytes,
} from "./protocol";

const PLAYER = "0123456789abcdef0123456789abcdef";
const hello = { t: "hello", v: 1, name: "Robo", team: "tabs", player: PLAYER, touch: false };
const input = { t: "input", seq: 5, mx: 0.5, my: -1, aim: 1.25, fire: false, dash: true };
const s = (m: unknown) => JSON.stringify(m);

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
      if (key === "t") continue;
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
  test("a snapshot is built from a shared players part and round-trips, quantized", () => {
    const players = [
      { id: 1, x: 10.123456, y: 20.5, vx: -3.004, vy: 0, aim: 1.23456 },
      { id: 2, x: 2386, y: 14, vx: 300, vy: -299.999, aim: -3.14159 },
    ];
    const shared = encodeSnapshotPlayers(players);
    const msg = parseServerMessage(encodeSnapshot(9, 4, shared));
    expect(msg).toEqual({
      t: "snapshot",
      tick: 9,
      ack: 4,
      p: [
        [1, 10.12, 20.5, -3, 0, 1.235],
        [2, 2386, 14, 300, -300, -3.142],
      ],
    });
    expect(parseServerMessage(encodeSnapshot(1, 0, encodeSnapshotPlayers([])))).toEqual({ t: "snapshot", tick: 1, ack: 0, p: [] });
  });

  test("parseServerMessage accepts only known types", () => {
    for (const t of SERVER_TYPES) expect(parseServerMessage(s({ t }))).toEqual({ t } as never);
    for (const t of CLIENT_TYPES) expect(parseServerMessage(s({ t }))).toBeNull();
    expect(parseServerMessage("{")).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
  });
});
