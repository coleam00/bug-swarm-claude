import { describe, expect, test } from "bun:test";
import { MAX_UPGRADES, UPGRADE_IDS, UPGRADE_MAX_LEVEL, checkName, checkScore, isUpgradeId, nameKey, normalizeName } from "./rules";

describe("name rules", () => {
  test("a valid name passes and comes back normalized", () => {
    expect(checkName("Robo_Fan-42")).toEqual({ ok: true, name: "Robo_Fan-42" });
    expect(checkName("  big   bug  ")).toEqual({ ok: true, name: "big bug" });
    expect(normalizeName("  a  b   c ")).toBe("a b c");
    expect(nameKey(" Big  Bug ")).toBe("big bug");
  });

  test("2 to 16 characters, measured after trimming", () => {
    expect(checkName("a")).toEqual({ ok: false, reason: "length" });
    expect(checkName("   a   ")).toEqual({ ok: false, reason: "length" });
    expect(checkName("ab").ok).toBe(true);
    expect(checkName("abcdefghijklmnop").ok).toBe(true);
    expect(checkName("abcdefghijklmnopq")).toEqual({ ok: false, reason: "length" });
    expect(checkName("")).toEqual({ ok: false, reason: "length" });
  });

  test("only ASCII letters, numbers, spaces, - and _", () => {
    expect(checkName("bob!")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("<b>hi</b>")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("José")).toEqual({ ok: false, reason: "characters" });
    expect(checkName("a\tb")).toEqual({ ok: false, reason: "characters" });
  });

  test("blocked words are refused whatever the case, swaps or separators", () => {
    const refused = { ok: false, reason: "blocked" } as const;
    expect(checkName("shit")).toEqual(refused);
    expect(checkName("ShIt happens")).toEqual(refused);
    expect(checkName("sh1t")).toEqual(refused); // 1 -> i
    expect(checkName("b0ll0cks fuck")).toEqual(refused);
    expect(checkName("f0ck")).toEqual({ ok: true, name: "f0ck" }); // o, not u: not on the list
    expect(checkName("wh0re")).toEqual(refused); // 0 -> o
    expect(checkName("r3tard")).toEqual(refused); // 3 -> e
    expect(checkName("b4stard")).toEqual(refused); // 4 -> a
    expect(checkName("a55hole")).toEqual(refused); // 5 -> s
    expect(checkName("s h-i_t")).toEqual(refused);
    expect(checkName("xxFUCKxx")).toEqual(refused);
  });

  test("ordinary names that contain short words still pass", () => {
    expect(checkName("Cassie").ok).toBe(true);
    expect(checkName("peacock").ok).toBe(true);
    expect(checkName("grape").ok).toBe(true);
  });
});

describe("score plausibility", () => {
  // At 30 s elapsed: score cap is 10 * squashes + 32, squash cap 180, seconds cap 32.
  test("accepted exactly at each bound", () => {
    expect(checkScore({ score: 232, squashes: 20, seconds: 30 }, 30)).toEqual({ ok: true });
    expect(checkScore({ score: 0, squashes: 180, seconds: 32 }, 30)).toEqual({ ok: true });
    expect(checkScore({ score: 0, squashes: 0, seconds: 0 }, 0)).toEqual({ ok: true });
  });

  test("one point over the score bound is refused", () => {
    expect(checkScore({ score: 233, squashes: 20, seconds: 30 }, 30).ok).toBe(false);
  });

  test("more than 6 squashes per elapsed second is refused", () => {
    expect(checkScore({ score: 0, squashes: 181, seconds: 30 }, 30).ok).toBe(false);
  });

  test("claiming more seconds than really passed (plus 2 s slack) is refused", () => {
    expect(checkScore({ score: 0, squashes: 0, seconds: 32.5 }, 30).ok).toBe(false);
  });

  test("negative or non-integer values are refused", () => {
    expect(checkScore({ score: -1, squashes: 0, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 1.5, squashes: 0, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 0.5, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: -1, seconds: 1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 1, seconds: -1 }, 30).ok).toBe(false);
    expect(checkScore({ score: 10, squashes: 1, seconds: Number.NaN }, 30).ok).toBe(false);
  });
});

describe("upgrades", () => {
  test("every upgrade at its top level fits in what a finished run may report", () => {
    expect(UPGRADE_IDS.length * UPGRADE_MAX_LEVEL).toBeLessThanOrEqual(MAX_UPGRADES);
  });

  test("only the listed ids are upgrades", () => {
    for (const id of UPGRADE_IDS) expect(isUpgradeId(id)).toBe(true);
    for (const v of ["", "Review-Laser", "laser", "CI-Drone", "drone", 1, null, undefined]) expect(isUpgradeId(v)).toBe(false);
  });
});
