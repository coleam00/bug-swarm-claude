import { expect, test } from "bun:test";
import { RUN_STARTS_PER_WINDOW } from "./app";
import { startLimit } from "./limits";

test("unset or empty is the real limit, 30", () => {
  expect(RUN_STARTS_PER_WINDOW).toBe(30);
  expect(startLimit({})).toBe(30);
  expect(startLimit({ RUN_STARTS_PER_WINDOW: "" })).toBe(30);
});

test("a positive whole number raises it", () => {
  expect(startLimit({ RUN_STARTS_PER_WINDOW: "5000" })).toBe(5000);
  expect(startLimit({ RUN_STARTS_PER_WINDOW: "1" })).toBe(1);
});

test("anything else refuses to start, naming the variable", () => {
  for (const bad of ["0", "-1", "1.5", "abc", "1e3", " 5", "0x10", "05", "99999999999999999999"]) {
    expect(() => startLimit({ RUN_STARTS_PER_WINDOW: bad })).toThrow("RUN_STARTS_PER_WINDOW");
  }
});
