// How the game looks: every colour and size the renderer uses, in one place. Pure data.
import { BUG_RADIUS, type Bug } from "./sim";

/** Glow colours. sprites.ts bakes one glow sprite per entry; things refer to them by index. */
export const PALETTE = ["#fb923c", "#a3e635", "#22d3ee", "#fde047", "#ffffff"] as const;
export const GLOW_AMBER = 0;
export const GLOW_LIME = 1;
export const GLOW_CYAN = 2;
export const GLOW_SHOT = 3;
export const GLOW_WHITE = 4;

export const LETTERBOX = "#05070d";
export const FLOOR = "#070a12";
/** Grid line colour; drawn twice, once wide and faint for the glow, once thin. */
export const GRID_RGB = "56, 189, 248";
export const GRID_SPACING = 40;
export const ARENA_EDGE = "rgba(56, 189, 248, 0.35)";
export const VIGNETTE = "rgba(0, 0, 0, 0.6)";

export const ROBOT_BODY = "#1e293b";
export const ROBOT_RIM = "#22d3ee";
export const ROBOT_GLOW = GLOW_CYAN;
export const SHOT_CORE = "#fffbe6";
export const SHOT_GLOW = GLOW_SHOT;

export const TEXT_FONT = "bold 26px system-ui, sans-serif";
export const TEXT_FILL = "#ffffff";
export const TEXT_STROKE = "#05070d";

export type BugLook = {
  /** Drawn radius of the shell, in arena units. */
  radius: number;
  shell: string;
  /** The lighter highlight on the shell. */
  shine: string;
  head: string;
  legs: string;
  /** Palette index for its halo and its squash particles. */
  glow: number;
  /** Leg cycles a second. */
  legHz: number;
  /** How far a leg swings either way, in radians. */
  legSwing: number;
  /** How far the heading wobbles either way, in radians (0 walks straight at the robot). */
  jitter: number;
  /** Wobbles a second. */
  jitterHz: number;
};

export const BUG_LOOK_IDS = ["basic", "fast"] as const;
export type BugLookId = (typeof BUG_LOOK_IDS)[number];

export const BUG_LOOKS: Record<BugLookId, BugLook> = {
  basic: {
    radius: BUG_RADIUS,
    shell: "#c2410c",
    shine: "#fb923c",
    head: "#431407",
    legs: "#fdba74",
    glow: GLOW_AMBER,
    legHz: 2.5,
    legSwing: 0.35,
    jitter: 0.05,
    jitterHz: 0.7,
  },
  // Waiting for the fast bug (issue #6): small, bright and twitchy.
  fast: {
    radius: 8,
    shell: "#65a30d",
    shine: "#d9f99d",
    head: "#1a2e05",
    legs: "#ecfccb",
    glow: GLOW_LIME,
    legHz: 6,
    legSwing: 0.5,
    jitter: 0.35,
    jitterHz: 5,
  },
};

/** Which look a bug gets. Every bug is basic until the sim gives bugs a kind (#6 switches this to `b.kind`). */
export function bugLookId(_b: Bug): BugLookId {
  return "basic";
}
