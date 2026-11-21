import { expect, test } from "bun:test";
import { CI_DRONE, REFACTOR_BOMB, REVIEW_LASER, TEST_SHIELD } from "../server/rules";
import { MAX_SCORE, rankLines, saveNotice, upgradeLevels } from "./over";

test("no upgrades: an empty list", () => {
  expect(upgradeLevels([])).toEqual([]);
});

test("each upgrade once, in the order first taken, at the level its picks reached", () => {
  expect(upgradeLevels([REVIEW_LASER, TEST_SHIELD, REVIEW_LASER])).toEqual([
    { id: REVIEW_LASER, name: "Review laser", level: 2 },
    { id: TEST_SHIELD, name: "Test shield", level: 1 },
  ]);
  const all = upgradeLevels([CI_DRONE, REFACTOR_BOMB, CI_DRONE, TEST_SHIELD, REVIEW_LASER, REFACTOR_BOMB, TEST_SHIELD, REVIEW_LASER]);
  expect(all.map((u) => `${u.id} ${u.level}`)).toEqual([`${CI_DRONE} 2`, `${REFACTOR_BOMB} 2`, `${TEST_SHIELD} 2`, `${REVIEW_LASER} 2`]);
});

test("the save line: the too-many-runs refusal and a failed save each have their own; otherwise none", () => {
  expect(saveNotice("rate-limited")).toBe("Too many runs right now. Your next run will save.");
  expect(saveNotice("failed")).toBe("Couldn't save your score");
  for (const s of ["saving", "saved", "not-saved"] as const) expect(saveNotice(s)).toBeNull();
});

test("rank lines: none without a rank; the top-10 line through #10; the gap to the rank above from #11", () => {
  expect(rankLines(null)).toEqual([]);
  expect(rankLines({ rank: null, ranked: 5, next: null, row: null })).toEqual([]);
  expect(rankLines({ rank: 1, ranked: 1, next: null, row: 0 })).toEqual(["Your best is #1 of 1", "You're in the top 10!"]);
  expect(rankLines({ rank: 10, ranked: 214, next: { rank: 9, points: 3 }, row: 9 })).toEqual(["Your best is #10 of 214", "You're in the top 10!"]);
  expect(rankLines({ rank: 11, ranked: 214, next: { rank: 10, points: 1 }, row: null })).toEqual(["Your best is #11 of 214", "1 point to beat #10"]);
  expect(rankLines({ rank: 1234, ranked: 2000, next: { rank: 1233, points: 15300 }, row: null })).toEqual([
    "Your best is #1,234 of 2,000",
    "15,300 points to beat #1,233",
  ]);
});

test("the widest score is the server's cap: 300 s of 5 squashes a second plus a point a second", () => {
  expect(MAX_SCORE).toBe(15300);
});
