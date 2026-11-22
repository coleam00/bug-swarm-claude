// The HUD's one line at the top (#64): your score and its multiplier, three small hit pips, the
// wave and how many are playing in your arena, left to right from the safe left edge, ending at
// least HUD_CLEAR before the minimap. When the long form ("Wave 3", "12 playing") does not fit,
// the short form ("W3", a small person glyph and "12"); when even that does not fit (a narrow
// phone and a big score), the line is scaled down to fit. Under it, a timer icon for each pickup
// you have active (#73). Pure: render.ts measures each text only when its value changes and draws
// at the places this lays out.
import { HITS_PER_LIFE } from "../../shared/arena/constants";

/** Between the score and its multiplier, CSS px. */
export const HUD_MULT_GAP = 6;
/** Between the other parts of the line, CSS px. */
export const HUD_GAP = 14;
/** The hit pips: radius and centre-to-centre spacing, CSS px. */
export const HUD_PIP_RADIUS = 5;
export const HUD_PIP_STEP = 14;
export const HUD_PIPS_WIDTH = HUD_PIP_RADIUS * 2 + (HITS_PER_LIFE - 1) * HUD_PIP_STEP;
/** The short form's person glyph and its gap before the count, CSS px. */
export const HUD_GLYPH_WIDTH = 10;
export const HUD_GLYPH_GAP = 4;
/** The line ends at least this far left of the minimap, CSS px. */
export const HUD_CLEAR = 12;

/** The measured widths of the line's texts, CSS px, at scale 1. */
export type HudWidths = {
  score: number;
  mult: number;
  /** "Wave 3" and "W3". */
  wave: number;
  waveShort: number;
  /** "12 playing" and "12". */
  players: number;
  playersShort: number;
};

/** Where each part starts (CSS px from `left`, before `scale`), which form, and the scale. */
export type HudLine = { short: boolean; scale: number; mult: number; pips: number; wave: number; players: number; width: number };

export function createHudLine(): HudLine {
  return { short: false, scale: 1, mult: 0, pips: 0, wave: 0, players: 0, width: 0 };
}

/** The line's width in one form. */
function place(w: HudWidths, short: boolean, out: HudLine): number {
  let x = w.score + HUD_MULT_GAP;
  out.mult = x;
  x += w.mult + HUD_GAP;
  out.pips = x;
  x += HUD_PIPS_WIDTH + HUD_GAP;
  out.wave = x;
  x += (short ? w.waveShort : w.wave) + HUD_GAP;
  out.players = x;
  x += short ? HUD_GLYPH_WIDTH + HUD_GLYPH_GAP + w.playersShort : w.players;
  return x;
}

/**
 * Lays the line out into `out` for a line starting at `left` that must end before `minimapX -
 * HUD_CLEAR`: the long form if it fits, else the short form, scaled down to fit if it must.
 */
export function layoutHudLine(left: number, minimapX: number, w: HudWidths, out: HudLine): HudLine {
  const room = Math.max(1, minimapX - HUD_CLEAR - left);
  out.short = false;
  out.width = place(w, false, out);
  if (out.width > room) {
    out.short = true;
    out.width = place(w, true, out);
  }
  out.scale = Math.min(1, room / out.width);
  return out;
}

// ---- Pickup timers (#73): your active pickups as small icons in a row under the line. ----

/** An icon's size and the gap between icons, CSS px. */
export const HUD_ICON_SIZE = 18;
export const HUD_ICON_GAP = 6;
/** The icons' centres, CSS px below the line's middle. */
export const HUD_ICONS_BELOW = 30;
/** What sits under the line ("streak lost", the F readout) moves down this far while any icon shows. */
export const HUD_ICONS_SHIFT = HUD_ICON_SIZE + HUD_ICON_GAP;

/** The centre of icon `i` (0 up, in the order the active pickups come in PICKUP_IDS), CSS px from the screen's left. */
export function hudIconX(left: number, i: number): number {
  return left + HUD_ICON_SIZE / 2 + i * (HUD_ICON_SIZE + HUD_ICON_GAP);
}

/** How far "streak lost" and the F readout move down with `count` icons showing. */
export function hudIconsShift(count: number): number {
  return count > 0 ? HUD_ICONS_SHIFT : 0;
}
