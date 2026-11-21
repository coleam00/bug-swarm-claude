import { expect, test } from "bun:test";
import { CI_DRONE, REFACTOR_BOMB, REVIEW_LASER, TEST_SHIELD } from "../server/rules";
import { saveNotice, upgradeLevels } from "./over";

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
