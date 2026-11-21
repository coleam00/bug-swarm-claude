import { describe, expect, test } from "bun:test";
import { SQUASH_LABEL, TEXT_CAPACITY, TEXT_RISE, TEXT_SECONDS, createTexts, spawnText, updateTexts } from "./text";

describe("floating text pool", () => {
  test("the label is the points a squash scores", () => {
    expect(SQUASH_LABEL).toBe("+10");
  });

  test("a label rises, then expires and frees its slot for reuse", () => {
    const t = createTexts();
    spawnText(t, 100, 200);
    updateTexts(t, 0.5);
    expect(t.y[0]).toBeCloseTo(200 - TEXT_RISE * 0.5, 3);
    expect(t.x[0]).toBe(100);
    expect(t.live).toBe(1);
    updateTexts(t, TEXT_SECONDS);
    expect(t.live).toBe(0);
    expect(t.life[0]).toBe(0);
    spawnText(t, 5, 5);
    expect(t.live).toBe(1);
    expect(t.life.length).toBe(TEXT_CAPACITY);
  });

  test("a full pool overwrites the oldest label and never grows", () => {
    const t = createTexts();
    for (let i = 0; i < TEXT_CAPACITY + 5; i++) spawnText(t, i, 0);
    expect(t.live).toBe(TEXT_CAPACITY);
    expect(t.life.length).toBe(TEXT_CAPACITY);
    for (let i = 0; i < 5; i++) expect(t.x[i]).toBe(TEXT_CAPACITY + i);
    expect(t.x[5]).toBe(5);
  });
});
