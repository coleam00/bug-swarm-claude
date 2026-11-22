import { expect, test } from "bun:test";
import { NO_INSETS, hudLayout } from "../game/hud";
import { PICKUP_IDS } from "../../shared/arena/constants";
import {
  HUD_CLEAR,
  HUD_ICONS_BELOW,
  HUD_ICONS_SHIFT,
  HUD_ICON_GAP,
  HUD_ICON_SIZE,
  createHudLine,
  hudIconX,
  hudIconsShift,
  layoutHudLine,
  type HudWidths,
} from "./hudline";
import { minimapLayout } from "./minimap";

// Widths about as the canvas measures them (bold system-ui): a 6-digit score at 26 px, "x1.5" at
// 18 px, "Wave 12" / "W12" and "20 playing" / "20" at 18 px.
const WORST: HudWidths = { score: 100, mult: 34, wave: 70, waveShort: 34, players: 92, playersShort: 22 };
const TYPICAL: HudWidths = { score: 50, mult: 22, wave: 58, waveShort: 22, players: 86, playersShort: 20 };

/** The line's right edge on screen at `w` x `h`, and the most it may reach. */
function edges(w: number, h: number, widths: HudWidths) {
  const hud = hudLayout(w, NO_INSETS);
  const map = minimapLayout(w, h, NO_INSETS);
  const line = layoutHudLine(hud.left, map.x, widths, createHudLine());
  return { line, end: hud.left + line.width * line.scale, limit: map.x - HUD_CLEAR };
}

test("on a desktop the long form fits at full size", () => {
  for (const [w, h] of [
    [1280, 720],
    [1440, 900],
  ] as const) {
    const { line, end, limit } = edges(w, h, WORST);
    expect(line.short).toBe(false);
    expect(line.scale).toBe(1);
    expect(end).toBeLessThanOrEqual(limit);
  }
});

test("on a phone the line always ends before the minimap: short form, scaled down only for the worst case", () => {
  for (const [w, h] of [
    [390, 844],
    [360, 640],
    [844, 390],
  ] as const) {
    for (const widths of [WORST, TYPICAL]) {
      const { end, limit } = edges(w, h, widths);
      expect(end).toBeLessThanOrEqual(limit + 1e-9);
    }
  }
  // A typical score on a 390 px phone: the short form, full size.
  const typical = edges(390, 844, TYPICAL).line;
  expect(typical.short).toBe(true);
  expect(typical.scale).toBe(1);
  // The worst case on the narrowest phone shrinks, but stays readable.
  const worst = edges(360, 640, WORST).line;
  expect(worst.short).toBe(true);
  expect(worst.scale).toBeLessThan(1);
  expect(worst.scale).toBeGreaterThan(0.6);
  // Landscape has room for the long form.
  expect(edges(844, 390, WORST).line.short).toBe(false);
});

test("parts are laid out left to right in order", () => {
  const line = layoutHudLine(16, 2000, TYPICAL, createHudLine());
  expect(line.mult).toBeGreaterThan(TYPICAL.score);
  expect(line.pips).toBeGreaterThan(line.mult + TYPICAL.mult);
  expect(line.wave).toBeGreaterThan(line.pips);
  expect(line.players).toBeGreaterThan(line.wave + TYPICAL.wave);
  expect(line.width).toBeGreaterThan(line.players);
});

test("pickup timers (#73): a row of icons under the line from its left edge, pushing what sits under the line down", () => {
  const hud = hudLayout(360, NO_INSETS);
  expect(hudIconsShift(0)).toBe(0);
  expect(hudIconsShift(1)).toBe(HUD_ICONS_SHIFT);
  expect(hudIconsShift(2)).toBe(HUD_ICONS_SHIFT);
  expect(hudIconX(hud.left, 0)).toBe(hud.left + HUD_ICON_SIZE / 2);
  expect(hudIconX(hud.left, 1) - hudIconX(hud.left, 0)).toBe(HUD_ICON_SIZE + HUD_ICON_GAP);
  // Every pickup's icon fits on a 360 px phone, left of the minimap and clear of the line's text.
  const map = minimapLayout(360, 640, NO_INSETS);
  expect(hudIconX(hud.left, PICKUP_IDS.length - 1) + HUD_ICON_SIZE / 2).toBeLessThan(map.x);
  expect(HUD_ICONS_BELOW - HUD_ICON_SIZE / 2).toBeGreaterThan(13);
});
