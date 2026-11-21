// Where the canvas HUD sits: a margin in from each edge, plus the screen's safe-area insets (a
// notch or a home bar, a phone held sideways), so the score and hearts never sit under them.
// Worked out on resize only (render.ts), never per frame.

/** Safe-area insets in CSS px (loop.ts reads them from index.html's .safe-probe). */
export type Insets = { top: number; right: number; bottom: number; left: number };

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The HUD's gap from the screen's (safe) edges, CSS px. */
export const HUD_MARGIN = 16;
/** The F readout's line, under the HUD's top row, from the top of the safe area. */
export const STATS_Y = 52;

export type HudLayout = { left: number; center: number; right: number; top: number; statsTop: number };

/** The HUD's anchors on a canvas `width` CSS px wide: score left, time centred, hearts right. */
export function hudLayout(width: number, insets: Insets): HudLayout {
  const left = HUD_MARGIN + insets.left;
  const right = width - HUD_MARGIN - insets.right;
  return { left, right, center: (left + right) / 2, top: HUD_MARGIN + insets.top, statsTop: STATS_Y + insets.top };
}
