// How the game looks: every colour and size the renderer uses, in one place. Pure data.
import { BUG_KINDS, ROBOT_RADIUS } from "./config";

/** Glow colours. sprites.ts bakes one glow sprite per entry; things refer to them by index. */
export const PALETTE = ["#fb923c", "#a3e635", "#22d3ee", "#fde047", "#ffffff", "#c084fc", "#ff2d95", "#7dd3fc", "#f43f5e", "#7cff3a", "#e8ff5a", "#93c5fd"] as const;
export const GLOW_AMBER = 0;
export const GLOW_LIME = 1;
export const GLOW_CYAN = 2;
export const GLOW_SHOT = 3;
export const GLOW_WHITE = 4;
/** Hot pink: the arena's dasher (#65). */
export const GLOW_PINK = 6;
/** Sky blue: the arena's test shield (#73). */
export const GLOW_SHIELD = 7;
/** Rose red: the arena's review laser (#73). */
export const GLOW_LASER = 8;
/** Acid green: the arena's spitter (#72). */
export const GLOW_ACID = 9;
/** Hot yellow-green: a spitter's glob (#72), bright so it reads in a swarm. */
export const GLOW_GLOB = 10;
/** Steel blue: the arena's beetle (#80) and the spark off its shell. */
export const GLOW_STEEL = 11;

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
/**
 * The "you are here" marker, drawn above everything in the arena so the robot is found in a full
 * swarm and on a stream shown small: a white ring on a dark outline, in a soft cyan halo. White so
 * it never reads as the robot's rim (cyan).
 */
export const ROBOT_MARK = "#ffffff";
export const ROBOT_MARK_OUTLINE = "#05070d";
export const ROBOT_MARK_RADIUS = ROBOT_RADIUS * 1.25;
export const ROBOT_MARK_WIDTH = 2.5;
export const ROBOT_MARK_OUTLINE_WIDTH = 5;
export const ROBOT_HALO_RADIUS = ROBOT_RADIUS * 3.2;
export const ROBOT_HALO_ALPHA = 0.55;
export const SHOT_CORE = "#fffbe6";

export const TEXT_FONT = "bold 26px system-ui, sans-serif";
export const TEXT_FILL = "#ffffff";
export const TEXT_STROKE = "#05070d";

/** The touch joystick, drawn under the finger: a faint ring at full-speed range and a knob. */
export const STICK_RING = "rgba(125, 211, 252, 0.3)";
export const STICK_RING_WIDTH = 2;
export const STICK_KNOB = "rgba(248, 250, 252, 0.3)";
export const STICK_KNOB_RADIUS = 22;

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
