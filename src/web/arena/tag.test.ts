import { describe, expect, test } from "bun:test";
import { FILL_BOT_NAMES } from "../../server/arena/fill";
import { BOT_TAG_GAP, BOT_TAG_PAD, botTagBox, isBot } from "./tag";

describe("bot name tag", () => {
  test("every fill bot is tagged; people, and the bots script's players, are not", () => {
    for (const n of FILL_BOT_NAMES) expect(isBot(n)).toBe(true);
    for (const n of ["Ada", "bots-01", "robot", "Bot_x"]) expect(isBot(n)).toBe(false);
  });

  test("the pill sits just left of the centred name, its text padded on both sides", () => {
    const box = botTagBox(60, 20, { x: 0, w: 0 });
    expect(box.w).toBe(20 + 2 * BOT_TAG_PAD);
    // Its right edge is the gap left of the name's left edge (-30).
    expect(box.x + box.w).toBe(-30 - BOT_TAG_GAP);
  });
});
