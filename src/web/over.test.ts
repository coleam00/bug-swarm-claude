import { expect, test } from "bun:test";
import type { TopRow } from "./api";
import { fmt, topLine } from "./over";

const rows = (scores: number[]): TopRow[] => scores.map((score, i) => ({ name: `p${i}`, score }));
const TEN = rows([5000, 4000, 3000, 2500, 2000, 1500, 1200, 1000, 900, 800]);

test("on the top 10: its place", () => {
  expect(topLine({ rank: 3, ranked: 40, next: { rank: 2, points: 1001 }, row: 2 }, TEN, 3000)).toBe("#3 on the top 10");
  expect(topLine({ rank: 10, ranked: 40, next: { rank: 9, points: 101 }, row: 9 }, TEN, 800)).toBe("#10 on the top 10");
});

test("with fewer than 10 ranked, a player with a best is on it", () => {
  expect(topLine({ rank: 2, ranked: 2, next: { rank: 1, points: 11 }, row: 1 }, rows([100, 90]), 90)).toBe("#2 on the top 10");
});

test("below it: one more than the 10th row's score minus the best, not the gap to the rank just above", () => {
  expect(topLine({ rank: 11, ranked: 40, next: { rank: 10, points: 21 }, row: null }, TEN, 780)).toBe("21 points to reach the top 10");
  expect(topLine({ rank: 25, ranked: 40, next: { rank: 24, points: 5 }, row: null }, TEN, 120)).toBe("681 points to reach the top 10");
  expect(topLine({ rank: 11, ranked: 40, next: { rank: 10, points: 1 }, row: null }, TEN, 800)).toBe("1 point to reach the top 10");
  // The rows can lag the best by a cached second: never 0 or less.
  expect(topLine({ rank: 11, ranked: 40, next: { rank: 10, points: 1 }, row: null }, TEN, 900)).toBe("1 point to reach the top 10");
  expect(topLine({ rank: 1234, ranked: 2000, next: null, row: null }, rows(Array<number>(10).fill(15300)), 0)).toBe(
    "15,301 points to reach the top 10",
  );
});

test("when another player's life holds the name's row: who holds it, where, and with what", () => {
  const me = { rank: null, ranked: 40, next: null, row: null, held: { name: "Churn", rank: 1, score: 1900 } };
  expect(topLine(me, TEN, 300)).toBe("Churn holds #1 with 1,900");
  expect(topLine({ ...me, held: { name: "CHURN", rank: 14, score: 300 } }, TEN, 120)).toBe("CHURN holds #14 with 300");
  expect(topLine(me, TEN, null)).toBeNull();
});

test("nothing without a rank or a best: hidden, no saved life yet, or the read failed", () => {
  expect(topLine(null, TEN, 500)).toBeNull();
  expect(topLine({ rank: null, ranked: 40, next: null, row: null }, TEN, 500)).toBeNull();
  expect(topLine({ rank: 3, ranked: 40, next: null, row: 2 }, TEN, null)).toBeNull();
});

test("counts are written as the board writes them", () => {
  expect(fmt(466548)).toBe("466,548");
});
