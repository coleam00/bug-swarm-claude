// The hive queen's HUD pieces (#85): her health bar's place and fill, her marker's pulse and
// countdown, and the banners' timer, opacity, place and fit, and the golden bug's banner text (#122).
import { describe, expect, test } from "bun:test";
import { DT } from "../../shared/arena/constants";
import { QUEEN_MARKER_TICKS } from "../../shared/arena/queen";
import { HUD_ICONS_SHIFT } from "./hudline";
import {
  BANNER_IN_S,
  BANNER_OUT_S,
  BANNER_S,
  QUEEN_BAR_GAP,
  QUEEN_BAR_MAX,
  bannerAlpha,
  bannerFloor,
  bannerY,
  barFill,
  createBanner,
  fitScale,
  goldenBannerText,
  markerLook,
  queenBarLayout,
  showBanner,
  updateBanner,
  type QueenBar,
} from "./queenhud";
import { minimapLayout } from "./minimap";
import { hudLayout } from "../game/hud";

const bar = (): QueenBar => ({ x: 0, labelY: 0, y: 0, w: 0 });

describe("health bar", () => {
  test("from the HUD's left to short of the minimap, at most QUEEN_BAR_MAX wide, at 390, 844 and 1280 wide", () => {
    for (const [w, h] of [
      [390, 844],
      [844, 390],
      [1280, 800],
    ] as const) {
      const insets = { top: 0, right: 0, bottom: 0, left: 0 };
      const m = minimapLayout(w, h, insets);
      const hud = hudLayout(w, insets);
      const b = queenBarLayout(hud.left, 30, m.x, 0, bar());
      expect(b.x).toBe(hud.left);
      expect(b.x + b.w).toBeLessThanOrEqual(m.x - QUEEN_BAR_GAP);
      expect(b.w).toBeLessThanOrEqual(QUEEN_BAR_MAX);
      expect(b.w).toBeGreaterThan(200);
    }
  });

  test("it sits under the pickup icons while any show, and is never negative", () => {
    const plain = queenBarLayout(16, 30, 600, 0, bar());
    const moved = queenBarLayout(16, 30, 600, 2, bar());
    expect(moved.y - plain.y).toBe(HUD_ICONS_SHIFT);
    expect(moved.labelY - plain.labelY).toBe(HUD_ICONS_SHIFT);
    expect(plain.labelY).toBeLessThan(plain.y);
    expect(queenBarLayout(500, 30, 400, 0, bar()).w).toBe(0);
  });

  test("its fill is hit points left of those she arrived with, held to 0..1", () => {
    expect(barFill(60, 120)).toBe(0.5);
    expect(barFill(0, 120)).toBe(0);
    expect(barFill(200, 120)).toBe(1);
    expect(barFill(5, 0)).toBe(0);
  });
});

describe("marker", () => {
  test("its countdown runs from 1 to 0 over the marker's 2 s, and its pulse stays in 0..1", () => {
    const m = { pulse: 0, left: 0 };
    expect(markerLook(QUEEN_MARKER_TICKS, 0, m).left).toBe(1);
    expect(markerLook(QUEEN_MARKER_TICKS / 2, 0, m).left).toBeCloseTo(0.5, 9);
    expect(markerLook(0, 0, m).left).toBe(0);
    expect(QUEEN_MARKER_TICKS * DT).toBeCloseTo(2, 9);
    for (let t = 0; t < 2; t += 0.037) {
      markerLook(10, t, m);
      expect(m.pulse).toBeGreaterThanOrEqual(0);
      expect(m.pulse).toBeLessThanOrEqual(1);
    }
  });
});

describe("banners", () => {
  test("Queen down! shows for BANNER_S, fading in and out, then is gone", () => {
    const b = createBanner();
    expect(bannerAlpha(b.left)).toBe(0);
    showBanner(b, 7);
    expect([b.left, b.top]).toEqual([BANNER_S, 7]);
    expect(bannerAlpha(b.left)).toBe(0);
    updateBanner(b, BANNER_IN_S / 2);
    expect(bannerAlpha(b.left)).toBeCloseTo(0.5, 9);
    updateBanner(b, BANNER_IN_S);
    expect(bannerAlpha(b.left)).toBe(1);
    updateBanner(b, BANNER_S - 2 * BANNER_IN_S - BANNER_OUT_S / 2);
    expect(bannerAlpha(b.left)).toBeCloseTo(0.5 + BANNER_IN_S / 2 / BANNER_OUT_S, 6);
    updateBanner(b, 10);
    expect([b.left, bannerAlpha(b.left)]).toEqual([0, 0]);
  });

  test("the golden bug's banner (#122) names its killer, or says it is down when the killer has left", () => {
    expect(goldenBannerText("Ada")).toBe("Ada got the golden bug!");
    expect(goldenBannerText("")).toBe("Golden bug down!");
  });

  test("they sit in the upper third, never above the floor given (under the HUD and the minimap)", () => {
    expect(bannerY(800, 100)).toBeCloseTo(224, 9);
    expect(bannerY(390, 200)).toBe(200);
    expect(bannerY(844, 150)).toBeLessThan(844 / 3);
  });

  test("under the minimap only when the text reaches its columns: a landscape phone keeps it above your robot", () => {
    // 844x390: the minimap is 120 wide at x 712; a 350 px banner centred at 422 ends at 597.
    expect(bannerFloor(422, 175, 712, 164, 120, 16)).toBe(120);
    expect(bannerY(390, bannerFloor(422, 175, 712, 164, 120, 16))).toBe(120);
    // 390x844: the banner spans the screen, so it goes under the minimap (x 258).
    expect(bannerFloor(195, 179, 258, 164, 120, 16)).toBe(164);
    // It never sits above the HUD, even under a short minimap.
    expect(bannerFloor(195, 179, 258, 100, 120, 16)).toBe(120);
  });

  test("text too wide for the screen is scaled to fit; text that fits is not", () => {
    expect(fitScale(300, 358)).toBe(1);
    expect(fitScale(400, 358)).toBeCloseTo(0.895, 3);
    expect(fitScale(0, 10)).toBe(1);
  });
});
