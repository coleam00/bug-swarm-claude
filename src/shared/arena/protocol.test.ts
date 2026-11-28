import { describe, expect, test } from "bun:test";
import { MAX_CLIENT_MESSAGE_BYTES } from "./constants";
import {
  CLIENT_TYPES,
  EVENT,
  EVENT_KINDS,
  GRENADE,
  QUEEN,
  SERVER_TYPES,
  type ArenaEvent,
  encodeHello,
  encodeInput,
  encodeVisibility,
  encodeWatch,
  parseClientMessage,
  parseServerMessage,
  utf8Bytes,
} from "./protocol";

const PLAYER = "0123456789abcdef0123456789abcdef";
const hello = { t: "hello", v: 1, name: "Robo", team: "tabs", player: PLAYER, touch: false, build: "" };
const input = { t: "input", seq: 5, mx: 0.5, my: -1, aim: 1.25, fire: false, dash: true, grenade: false };
const s = (m: unknown) => JSON.stringify(m);
/** A player row's down fields while not down. */

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
    expect(parseClientMessage(encodeInput({ seq: 5, mx: 0.5, my: -1, aim: 1.25, fire: false, dash: true, grenade: false }))).toEqual(input as never);
  });

  test("v13: an input's grenade press (#130) is a boolean it must carry", () => {
    expect(parseClientMessage(s({ ...input, grenade: true }))).toEqual({ ...input, grenade: true } as never);
    const { grenade: _, ...noGrenade } = input;
    expect(parseClientMessage(s(noGrenade))).toBeNull();
    expect(parseClientMessage(s({ ...input, grenade: 1 }))).toBeNull();
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

  test("a visibility message (#117) parses to whether the tab is hidden; anything but a boolean drops it", () => {
    expect(parseClientMessage(encodeVisibility(true))).toEqual({ t: "visibility", hidden: true });
    expect(parseClientMessage(encodeVisibility(false))).toEqual({ t: "visibility", hidden: false });
    expect(parseClientMessage(s({ t: "visibility", hidden: false, x: 1 }))).toEqual({ t: "visibility", hidden: false });
    expect(parseClientMessage(s({ t: "visibility" }))).toBeNull();
    expect(parseClientMessage(s({ t: "visibility", hidden: 1 }))).toBeNull();
    expect(parseClientMessage(s({ t: "visibility", hidden: "true" }))).toBeNull();
    expect(parseClientMessage(s({ t: "visibility", hidden: null }))).toBeNull();
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
    expect(parseClientMessage('{"t":"input","seq":1,"mx":NaN,"my":0,"aim":0,"fire":false,"dash":false,"grenade":false}')).toBeNull();
    expect(parseClientMessage('{"t":"input","seq":1,"mx":1e999,"my":0,"aim":0,"fire":false,"dash":false,"grenade":false}')).toBeNull();
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
  test("parseServerMessage accepts only known types", () => {
    for (const t of SERVER_TYPES) expect(parseServerMessage(s({ t }))).toEqual({ t } as never);
    for (const t of CLIENT_TYPES) expect(parseServerMessage(s({ t }))).toBeNull();
    expect(parseServerMessage("{")).toBeNull();
    expect(parseServerMessage(new ArrayBuffer(4))).toBeNull();
  });

  test("v12: a `queen` event (#85) names the top dealer and every reward", () => {
    const ev: ArenaEvent = { t: EVENT, kind: QUEEN, id: 3, paid: [[3, 475], [5, 275]] };
    expect(parseServerMessage(JSON.stringify(ev))).toEqual(ev);
  });

  test("v13: a `grenade` event (#130) names the thrower and its flight, and is the last event kind", () => {
    const ev: ArenaEvent = { t: EVENT, kind: GRENADE, id: 3, gr: [100.5, 200, 420.5, 200, 77] };
    expect(parseServerMessage(JSON.stringify(ev))).toEqual(ev);
    expect(EVENT_KINDS.at(-1)).toBe("grenade");
    expect(EVENT_KINDS.indexOf("queen")).toBe(7);
  });
});
