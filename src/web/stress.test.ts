import { expect, test } from "bun:test";
import { MAX_BUGS, STRESS_DEFAULT } from "./game/config";
import { STRESS, parseStress } from "./stress";

test("off unless allowed (a production build never allows it)", () => {
  expect(parseStress("?stress=150", false)).toBe(0);
  expect(parseStress("?stress", false)).toBe(0);
  expect(STRESS).toBe(0); // no dev server and no page under bun test
});

test("allowed: a bare flag is the default count, a whole count in range is itself, anything else is off", () => {
  expect(parseStress("", true)).toBe(0);
  expect(parseStress("?other=1", true)).toBe(0);
  expect(parseStress("?stress", true)).toBe(STRESS_DEFAULT);
  expect(parseStress("?stress=150", true)).toBe(150);
  expect(parseStress("?a=1&stress=40", true)).toBe(40);
  expect(parseStress(`?stress=${MAX_BUGS}`, true)).toBe(MAX_BUGS);
  for (const bad of ["abc", "0", "-5", "12.5", "1e2", String(MAX_BUGS + 1), "999"]) {
    expect(parseStress(`?stress=${bad}`, true)).toBe(0);
  }
});
