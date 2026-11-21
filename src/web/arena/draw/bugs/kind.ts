// What drawing a bug kind takes (#65): one file per kind in this folder exports a BugDraw, listed
// in index.ts by kind id. render.ts builds each kind's sprites from its `look` on resize, then
// per frame calls every kind's `under` (lines and marks beneath every body) and `draw` (the body).
import type { BugLook } from "../../../game/look";
import type { BugsView } from "../../render";

/** What a kind's draw functions get, filled by render.ts once per frame and reused. */
export type BugFrame = {
  ctx: CanvasRenderingContext2D;
  /** Device px per world unit, and the world's origin on the canvas: world (x, y) is at (k x + ox, k y + oy). */
  k: number;
  ox: number;
  oy: number;
  /** Seconds, for pulses and leg frames. */
  t: number;
  /** The view plus a margin, world units: anything wholly outside is not drawn. */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** This kind's leg frames (sprites.ts buildBugLookSprites of its look). */
  frames: readonly HTMLCanvasElement[];
  /** A soft glow in this kind's colour, for additive blending. */
  glow: HTMLCanvasElement;
};

export type BugDraw = {
  look: BugLook;
  /**
   * Optional: what goes under every bug's body for bug `i` (for example a dasher's aim line).
   * Called for every bug of this kind, in view or not: it culls itself, since what it draws can
   * reach the screen from a bug that is off it. Leaves the canvas state as it found it.
   */
  under?(f: BugFrame, view: BugsView, i: number): void;
  /** Bug `i`'s body, called only when its centre is in view. Leaves the canvas state as it found it. */
  draw(f: BugFrame, view: BugsView, i: number): void;
};
