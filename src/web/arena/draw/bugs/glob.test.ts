// How a glob reads on screen (#72): the pure part of its drawing.
import { describe, expect, test } from "bun:test";
import { FADE, FADE_TICKS, FLY } from "../../../../shared/arena/bugs/glob";
import { DT } from "../../../../shared/arena/constants";
import { globAlpha } from "./glob";

describe("glob look", () => {
  test("fully bright in flight, fading to nothing over its fade", () => {
    expect(globAlpha(FLY, 1.9)).toBe(1);
    expect(globAlpha(FADE, 0)).toBe(1);
    expect(globAlpha(FADE, (FADE_TICKS * DT) / 2)).toBeCloseTo(0.5, 9);
    expect(globAlpha(FADE, FADE_TICKS * DT)).toBe(0);
  });
});
