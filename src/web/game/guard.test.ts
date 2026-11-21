import { expect, test } from "bun:test";
import { restartIn } from "./guard";

test("play again is refused until 800 ms after the life ended", () => {
  const diedAt = 1000;
  expect(restartIn(diedAt, 1000)).toBe(800);
  expect(restartIn(diedAt, 1799)).toBe(1);
  expect(restartIn(diedAt, 1800)).toBe(0);
  expect(restartIn(diedAt, 5000)).toBe(0);
});
