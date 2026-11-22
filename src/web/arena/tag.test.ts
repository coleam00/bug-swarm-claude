import { describe, expect, test } from "bun:test";
import { FILL_BOT_NAMES } from "../../server/arena/fill";
import { BOT_TAG_GAP, BOT_TAG_PAD, HELP_ABOVE, HELP_ASCENT, HELP_UNDER_NAME, NAME_ABOVE, NAME_ASCENT, NAME_BELOW, botTagBox, countPeople, isBot, tagBaselines } from "./tag";

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

describe("people playing (#90)", () => {
  test("the HUD's count is the people in the roster; bots are never counted", () => {
    expect(countPeople([])).toBe(0);
    expect(countPeople([{ bot: true }, { bot: false }, { bot: true }, { bot: false }, { bot: true }])).toBe(2);
    expect(countPeople(new Map([[1, { bot: true }]]).values())).toBe(0);
  });
});

describe("name tags clear of the HUD band (#90)", () => {
  const spot = { name: 0, help: 0 };

  test("far below the band: the name and HELP sit over the robot as always", () => {
    expect(tagBaselines(500, 40, false, spot)).toEqual({ name: 500 - NAME_ABOVE, help: 500 - HELP_ABOVE });
    expect(tagBaselines(500, -Infinity, true, spot)).toEqual({ name: 500 - NAME_ABOVE, help: 500 - HELP_ABOVE });
  });

  test("a tag that would reach the band flips under the robot, HELP under the name, both clear of the band", () => {
    // The name's top would be 2 units into the band.
    const y = 100 + NAME_ABOVE + NAME_ASCENT - 2;
    const s = tagBaselines(y, 100, false, spot);
    expect(s.name).toBe(y + NAME_BELOW + NAME_ASCENT);
    expect(s.help).toBe(s.name + HELP_UNDER_NAME);
    expect(s.name - NAME_ASCENT).toBeGreaterThan(y);
    // One unit lower it fits over the robot.
    expect(tagBaselines(y + 2, 100, false, spot).name).toBe(y + 2 - NAME_ABOVE);
    // Down, HELP's top decides: the same robot whose name fits flips when HELP would reach the band.
    expect(tagBaselines(y + 2, 100, true, spot).name).toBe(y + 2 + NAME_BELOW + NAME_ASCENT);
    // Down, with HELP's top just at the band's bottom: it stays over the robot.
    const yd = 100 + HELP_ABOVE + HELP_ASCENT;
    expect(tagBaselines(yd, 100, true, spot)).toEqual({ name: yd - NAME_ABOVE, help: yd - HELP_ABOVE });
  });

  test("a robot inside the band itself: its tag goes to the band's bottom, never under it", () => {
    const s = tagBaselines(30, 100, false, spot);
    expect(s.name - NAME_ASCENT).toBe(100);
    expect(s.help).toBe(s.name + HELP_UNDER_NAME);
  });
});
