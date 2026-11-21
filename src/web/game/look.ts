// How the game looks: every colour and size the renderer uses, in one place. Pure data.
import { BUG_KINDS, ROBOT_RADIUS } from "./config";
import type { Bug } from "./sim";

/** Glow colours. sprites.ts bakes one glow sprite per entry; things refer to them by index. */
export const PALETTE = ["#fb923c", "#a3e635", "#22d3ee", "#fde047", "#ffffff", "#c084fc"] as const;
export const GLOW_AMBER = 0;
export const GLOW_LIME = 1;
export const GLOW_CYAN = 2;
export const GLOW_SHOT = 3;
export const GLOW_WHITE = 4;
export const GLOW_DRONE = 5;

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
/** The test shield's bubble: one colour, faded with globalAlpha so no string is built per frame. */
export const SHIELD_COLOUR = "#7dd3fc";
/** The bubble's radius, in arena units; a second ring inside it at 2 charges. */
export const SHIELD_RADIUS = ROBOT_RADIUS * 1.9;
export const SHIELD_INNER = 0.78;
/** How far a popping bubble grows, as a multiple of its radius. */
export const POP_GROWTH = 1.8;
/** The CI drone: a small dark body in its own violet glow, and violet shots. */
export const DRONE_BODY = "#1e1b2e";
export const DRONE_GLOW = GLOW_DRONE;
export const DRONE_SHOT_CORE = "#f3e8ff";

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

/** One look per bug kind, by the kind's id in BUG_KINDS. */
export type BugLookId = (typeof BUG_KINDS)[number]["id"];
export const BUG_LOOK_IDS: readonly BugLookId[] = BUG_KINDS.map((k) => k.id);

export const BUG_LOOKS: Record<BugLookId, BugLook> = {
  base: {
    radius: BUG_KINDS[0].radius,
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
  // Small, bright and twitchy.
  fast: {
    radius: BUG_KINDS[1].radius,
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

/** Which look a bug gets: its kind's. */
export function bugLookId(b: Bug): BugLookId {
  return b.kind.id as BugLookId;
}
