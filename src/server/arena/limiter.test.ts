import { expect, test } from "bun:test";
import { createInputLimiter } from "./limiter";

test("30 inputs a second pass, the 31st drops, and the next window passes again", () => {
  const l = createInputLimiter(30);
  for (let i = 0; i < 30; i++) expect(l.allow(1000 + i * 10)).toBe(true);
  expect(l.allow(1500)).toBe(false);
  expect(l.allow(1999)).toBe(false);
  // The window started at the first input (1000), so it ends at 2000.
  for (let i = 0; i < 30; i++) expect(l.allow(2000 + i)).toBe(true);
  expect(l.allow(2030)).toBe(false);
});

test("a steady 20 a second never drops", () => {
  const l = createInputLimiter();
  for (let i = 0; i < 200; i++) expect(l.allow(i * 50)).toBe(true);
});
