import { describe, expect, test } from "bun:test";
import { CHOICE_DELAY_MS, RESTART_DELAY_MS, inputReady } from "./guard";

describe("restart guard", () => {
  test("is 800 ms", () => {
    expect(RESTART_DELAY_MS).toBe(800);
  });
  test("ignores a tap or key until 800 ms after death", () => {
    const diedAt = 1000;
    expect(inputReady(diedAt, 1000, RESTART_DELAY_MS)).toBe(false);
    expect(inputReady(diedAt, 1500, RESTART_DELAY_MS)).toBe(false);
    expect(inputReady(diedAt, 1799, RESTART_DELAY_MS)).toBe(false);
    expect(inputReady(diedAt, 1800, RESTART_DELAY_MS)).toBe(true);
    expect(inputReady(diedAt, 5000, RESTART_DELAY_MS)).toBe(true);
  });
});

describe("choice guard", () => {
  test("is 350 ms", () => {
    expect(CHOICE_DELAY_MS).toBe(350);
  });
  test("ignores a card tap or 1-3 until 350 ms after the choice opens", () => {
    const openedAt = 2000;
    expect(inputReady(openedAt, 2000, CHOICE_DELAY_MS)).toBe(false);
    expect(inputReady(openedAt, 2349, CHOICE_DELAY_MS)).toBe(false);
    expect(inputReady(openedAt, 2350, CHOICE_DELAY_MS)).toBe(true);
  });
});
