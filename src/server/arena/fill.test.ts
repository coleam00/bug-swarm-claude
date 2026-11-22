import { describe, expect, test } from "bun:test";
import { FILL_BOT_NAMES, botName, botTeam, botTarget, fillDelta } from "./fill";

describe("fill bots", () => {
  test("an arena with people is topped up to the target; past it, bots retire, never below none", () => {
    // [people, bots, delta] at a target of 4.
    const cases: [number, number, number][] = [
      [0, 0, 4],
      [0, 3, 1],
      [0, 5, -1],
      [1, 0, 3],
      [1, 2, 1],
      [1, 3, 0],
      [2, 3, -1],
      [3, 3, -2],
      [4, 3, -3],
      [4, 0, 0],
      [5, 1, -1],
      [5, 0, 0],
    ];
    for (const [people, bots, delta] of cases) expect([people, bots, fillDelta(people, bots, 4)]).toEqual([people, bots, delta]);
    expect(fillDelta(1, 0, 0)).toBe(0);
    expect(fillDelta(0, 3, 0)).toBe(0);
  });

  test("the target: the fill target with people, the demo size with only watchers, else none (#79)", () => {
    // [people, watchers, target] with fillTo 4 and demoTo 3.
    const cases: [number, number, number][] = [
      [0, 0, 0],
      [0, 1, 3],
      [0, 7, 3],
      [1, 0, 4],
      [2, 5, 4],
    ];
    for (const [people, watchers, target] of cases) expect([people, watchers, botTarget(people, watchers, 4, 3)]).toEqual([people, watchers, target]);
    expect(botTarget(1, 1, 0, 3)).toBe(0);
  });

  test("a bot takes the first name nobody has", () => {
    const used = new Set(["bot Ada", "bot Grace"]);
    expect(botName((n) => used.has(n))).toBe("bot Linus");
    used.add("bot Linus");
    expect(botName((n) => used.has(n))).toBe("bot Alan");
    expect(FILL_BOT_NAMES.length).toBeGreaterThanOrEqual(20);
  });

  test("a bot joins the team with fewer players, tabs on a tie", () => {
    expect(botTeam([])).toBe("tabs");
    expect(botTeam([{ team: "tabs" }])).toBe("spaces");
    expect(botTeam([{ team: "spaces" }])).toBe("tabs");
    expect(botTeam([{ team: "tabs" }, { team: "spaces" }])).toBe("tabs");
    expect(botTeam([{ team: "spaces" }, { team: "spaces" }, { team: "tabs" }])).toBe("tabs");
  });
});
