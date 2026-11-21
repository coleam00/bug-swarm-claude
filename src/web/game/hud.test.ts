import { describe, expect, test } from "bun:test";
import { HUD_MARGIN, NO_INSETS, STATS_Y, hudLayout } from "./hud";

describe("hudLayout", () => {
  test("with no insets the HUD sits a margin in from the edges", () => {
    expect(hudLayout(844, NO_INSETS)).toEqual({ left: HUD_MARGIN, center: 422, right: 844 - HUD_MARGIN, top: HUD_MARGIN, statsTop: STATS_Y });
    expect(HUD_MARGIN).toBe(16);
    expect(STATS_Y).toBe(52);
  });

  test("a phone held sideways with a notch: the score and hearts move in past it", () => {
    const hud = hudLayout(844, { top: 0, right: 47, bottom: 21, left: 47 });
    expect(hud.left).toBe(63);
    expect(hud.right).toBe(781);
    expect(hud.center).toBe(422);
    expect(hud.top).toBe(16);
  });

  test("uneven side insets centre the time in the safe area", () => {
    const hud = hudLayout(800, { top: 0, right: 0, bottom: 0, left: 40 });
    expect(hud.left).toBe(56);
    expect(hud.right).toBe(784);
    expect(hud.center).toBe(420);
  });

  test("a top inset moves the HUD and the F readout down", () => {
    const hud = hudLayout(390, { top: 30, right: 0, bottom: 0, left: 0 });
    expect(hud.top).toBe(46);
    expect(hud.statsTop).toBe(82);
  });
});
