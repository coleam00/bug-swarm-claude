// What the hive queen (#85) puts on the HUD, laid out here and drawn by render.ts: her health bar
// under the HUD line, her marker's pulse and countdown while she arrives, and the banners ("The
// hive queen is coming", "Queen down!" with who dealt the most). Pure and allocation-free: every
// function writes into an object the caller keeps.
import { QUEEN_MARKER_TICKS } from "../../shared/arena/queen";
import { DT } from "../../shared/arena/constants";
import { hudIconsShift } from "./hudline";

/** The health bar: at most this wide, CSS px, ending at least QUEEN_BAR_GAP left of the minimap. */
export const QUEEN_BAR_MAX = 420;
export const QUEEN_BAR_GAP = 12;
/** Its label's baseline and the bar's top, CSS px below the HUD line's middle (under the pickup icons). */
export const QUEEN_LABEL_BELOW = 30;
export const QUEEN_BAR_BELOW = 36;
export const QUEEN_BAR_H = 10;
/** What sits under the line ("streak lost", the F readout) moves down this far while the bar shows. */
export const QUEEN_BAR_SHIFT = QUEEN_BAR_BELOW + QUEEN_BAR_H - 14;

export type QueenBar = { x: number; labelY: number; y: number; w: number };

/**
 * The bar's place, CSS px, into `out`: from the HUD's `left` to QUEEN_BAR_GAP short of the
 * minimap at `minimapX` (at most QUEEN_BAR_MAX), its label and bar under the line whose middle is
 * at `lineY`, below the pickup icons when `icons` show.
 */
export function queenBarLayout(left: number, lineY: number, minimapX: number, icons: number, out: QueenBar): QueenBar {
  const shift = hudIconsShift(icons);
  out.x = left;
  out.w = Math.max(0, Math.min(QUEEN_BAR_MAX, minimapX - QUEEN_BAR_GAP - left));
  out.labelY = lineY + QUEEN_LABEL_BELOW + shift;
  out.y = lineY + QUEEN_BAR_BELOW + shift;
  return out;
}

/** How full her bar is, 0 to 1: hit points left of those she arrived with. */
export function barFill(hp: number, maxHp: number): number {
  return maxHp > 0 ? Math.min(1, Math.max(0, hp / maxHp)) : 0;
}

/** Her marker's ring pulses this fast, cycles a second; its countdown arc empties over the marker's 2 s. */
export const MARKER_HZ = 2.5;
const MARKER_S = QUEEN_MARKER_TICKS * DT;

export type MarkerLook = { pulse: number; left: number };

/**
 * Her marker at scene time `t` seconds, `ticksLeft` ticks before she appears, into `out`: `pulse`
 * swings 0 to 1 at MARKER_HZ (the ring swells and brightens with it) and `left` is the countdown,
 * 1 when it appears and 0 as she does.
 */
export function markerLook(ticksLeft: number, t: number, out: MarkerLook): MarkerLook {
  out.pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * MARKER_HZ);
  out.left = Math.min(1, Math.max(0, (ticksLeft * DT) / MARKER_S));
  return out;
}

// ---- Banners ----

/** "Queen down!" stays this long, seconds, fading in over BANNER_IN_S and out over BANNER_OUT_S. */
export const BANNER_S = 3;
export const BANNER_IN_S = 0.2;
export const BANNER_OUT_S = 0.6;

/** The kill banner: seconds left (0: none) and the top damage dealer's id (0: nobody to name). */
export type Banner = { left: number; top: number };

export function createBanner(): Banner {
  return { left: 0, top: 0 };
}

/** Shows "Queen down!" for BANNER_S, naming player `top` (0: no name). */
export function showBanner(b: Banner, top: number): void {
  b.left = BANNER_S;
  b.top = top;
}

export function updateBanner(b: Banner, dt: number): void {
  b.left = Math.max(0, b.left - dt);
}

/** The banner's opacity with `left` seconds to go: fading in, holding, fading out; 0 when gone. */
export function bannerAlpha(left: number): number {
  if (left <= 0) return 0;
  const shown = BANNER_S - left;
  return Math.min(1, shown / BANNER_IN_S, left / BANNER_OUT_S);
}

/**
 * Where a banner's first line sits, CSS px from the top: in the upper third of a `cssH` tall
 * screen, and never above `floor` (under the HUD line, the bar and the minimap).
 */
export function bannerY(cssH: number, floor: number): number {
  return Math.max(floor, cssH * 0.28);
}

/**
 * The highest a banner `halfW` wide either side of `cx` may sit, CSS px from the top: under the
 * minimap (`minimapBottom`) only when the text reaches the minimap's columns (from `minimapX` less
 * `gap`), else just under the HUD (`hudBottom`: the line and the queen's bar). A landscape phone
 * (844x390) keeps the banner above your robot that way; a portrait one, whose banner spans the
 * screen, puts it under the minimap.
 */
export function bannerFloor(cx: number, halfW: number, minimapX: number, minimapBottom: number, hudBottom: number, gap: number): number {
  return cx + halfW > minimapX - gap ? Math.max(minimapBottom, hudBottom) : hudBottom;
}

/** The scale that fits text `textW` wide into `maxW` (1 when it fits already). */
export function fitScale(textW: number, maxW: number): number {
  return textW > maxW && textW > 0 ? Math.max(0, maxW) / textW : 1;
}
