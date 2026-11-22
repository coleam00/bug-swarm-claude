// Draws an arena frame: the floor grid, the walls, the bugs, every shot as a glowing streak, the
// sparks, kill bursts and floating scores, every robot with its trail, dash afterimage, barrel and
// name tag, your own ring, heat arc and dash cooldown ring, the dash button (touch screens), the
// HUD line (score and multiplier, hit pips, wave, people playing: hudline.ts) with a short "streak lost"
// under it, the sticks, the minimap and the F readout. While your life is over the arena keeps
// drawing with no HUD and no dash button: App.tsx's life-over screen dims it. A downed robot (#59) slumps and flickers inside a countdown ring with a pulsing
// HELP over it, a ring fills between it and whoever is reviving it, an arrow at the screen's edge
// points to each one out of view nearby, its minimap dot blinks, and your own HUD says DOWN with
// the seconds left. A server fill bot (#66) has a small BOT pill left of its name, which is drawn
// dimmer. A name tag (and HELP) that would reach the HUD band flips under its robot (#90, tag.ts).
// Pickups (#73): each on the floor as a halo, a disc and its glyph, blinking in its last
// 3 s; on every robot that has one, its look (a shield bubble, a glow at a laser's barrel, a CI drone orbiting, #84); a laser
// shot as a longer, brighter beam and a drone's in violet; your active ones as timer icons under the HUD line, each with a
// ring draining as it runs out. The hive queen (#85): her marker pulsing on the floor with its
// countdown while she arrives, her health bar under the HUD line while she lives, an arrow at the
// screen's edge to her when she is off it, her mark on the minimap, and the banners ("The hive
// queen is coming", "Queen down!"); all from the snapshot's `q`, so none depends on which bugs a
// snapshot carries. The start screen (watch) draws her marker and body but none of the rest.
// It reuses release 1's sprites and pooled
// effects (src/web/game/sprites.ts and fx/) so the arena looks like the same game. Sprites are
// built on resize only; a frame allocates nothing but the strings of a value that changed.
import { BUG_KINDS, DOWN_S, HITS_PER_LIFE, PICKUP_IDS, PICKUP_RADIUS, PLAYER_RADIUS, WORLD_H, WORLD_W, type BugKind } from "../../shared/arena/constants";
import { pickupDef } from "../../shared/arena/pickups/registry";
import { QUEEN_RADIUS } from "../../shared/arena/bugs/queen";
import type { SnapshotMe, SnapshotQueen } from "../../shared/arena/protocol";
import type { Team } from "../../server/rules";
import type { Particles } from "../game/fx/particles";
import { ringAt, type RingAt, type Rings } from "../game/fx/rings";
import type { Shake } from "../game/fx/shake";
import { TEXT_SECONDS, textLabel, type Texts } from "../game/fx/text";
import { TRAIL_SECONDS, trailSlot, type Trail } from "../game/fx/trail";
import type { Insets } from "../game/hud";
import { hudLayout } from "../game/hud";
import {
  BOMB_RING,
  BOMB_RING_GLOW_ALPHA,
  BOMB_RING_GLOW_WIDTH,
  BOMB_RING_WIDTH,
  GLOW_DRONE,
  GLOW_LASER,
  GLOW_QUEEN,
  GLOW_SHOT,
  GLOW_WHITE,
  LETTERBOX,
  PALETTE,
  ROBOT_HALO_ALPHA,
  ROBOT_HALO_RADIUS,
  SHOT_CORE,
  DRONE_SHOT_CORE,
  STICK_KNOB,
  STICK_KNOB_RADIUS,
  STICK_RING,
  STICK_RING_WIDTH,
  TEXT_FILL,
  TEXT_FONT,
  TEXT_STROKE,
  VIGNETTE,
} from "../game/look";
import { ROBOT_MARK_HALF, ROBOT_SPRITE_HALF, buildBugLookSprites, buildGlow, buildRobot, floorTile, robotMarkSprite } from "../game/sprites";
import { STICK_RANGE, stickKnob, type Stick } from "../game/stick";
import { TEAM_LOOK } from "../teams";
import type { Camera } from "./camera";
import type { DashButton } from "./controls";
import { BUG_DRAW } from "./draw/bugs";
import type { BugFrame } from "./draw/bugs/kind";
import { PICKUP_DRAW } from "./draw/pickups";
import { floorAlpha } from "./draw/pickups/kind";
import { edgeArrow, minimapDotOn, type EdgeArrow } from "./help";
import { HIT_FLASH_S, STREAK_LOST_S, flashOn, heatWarning, pulseScale, type HudFx } from "./hudfx";
import {
  HUD_GLYPH_GAP,
  HUD_GLYPH_WIDTH,
  HUD_ICONS_BELOW,
  HUD_ICON_SIZE,
  HUD_PIP_RADIUS,
  HUD_PIP_STEP,
  createHudLine,
  hudIconX,
  hudIconsShift,
  layoutHudLine,
  type HudWidths,
} from "./hudline";
import { minimapLayout, toMinimap, type MinimapLayout } from "./minimap";
import {
  QUEEN_BAR_H,
  QUEEN_BAR_SHIFT,
  bannerAlpha,
  bannerFloor,
  bannerY,
  barFill,
  fitScale,
  markerLook,
  queenBarLayout,
  type Banner,
  type MarkerLook,
  type QueenBar,
} from "./queenhud";
import { shotTravel, type ClientShots } from "./shots";
import { TING_S, tingLook, type TingLook, type Tings } from "./tings";
import { BOT_TAG, botTagBox, tagBaselines, type TagBox, type TagSpot } from "./tag";

/** The floor tile's side, world units (a multiple of the grid spacing). */
const TILE = 240;
const TAU = Math.PI * 2;
/** The barrel: a rounded bar from the robot's edge along the aim, world units. */
const BARREL_LENGTH = 10;
const BARREL_WIDTH = 5;
const BARREL_COLOUR = "#e2e8f0";
const NAME_FONT = "bold 13px system-ui, sans-serif";
const NAME_FILL = "#f8fafc";
/** A fill bot's name is drawn at this opacity (#66). */
const BOT_NAME_ALPHA = 0.55;
/** Its BOT pill: text, fill, and the pill's height and corner from the name's baseline, world units. */
const BOT_TAG_FONT = "bold 9px system-ui, sans-serif";
const BOT_TAG_TEXT = "#0f172a";
const BOT_TAG_FILL = "rgba(203, 213, 225, 0.8)";
const BOT_TAG_TOP = 11;
const BOT_TAG_H = 13;
const BOT_TAG_BASE = 1.5;
const WALL_GLOW = "rgba(34, 211, 238, 0.18)";
const WALL_GLOW_WIDTH = 14;
const WALL = "rgba(34, 211, 238, 0.85)";
const WALL_WIDTH = 2.5;
const MINIMAP_FILL = "rgba(5, 7, 13, 0.75)";
const MINIMAP_EDGE = "rgba(34, 211, 238, 0.7)";
const MINIMAP_VIEW = "rgba(248, 250, 252, 0.25)";
const MINIMAP_DOT = 3;
const MINIMAP_BUG = "rgba(251, 146, 60, 0.85)";
const STATS_FONT = "bold 16px system-ui, sans-serif";
const PARTICLE_SIZE = 7;
/** A blocked shot's ting (#80): its ring, and its word over the spot, world units above it. */
const TING_RING = "#e0f2fe";
const TING_WORD = "ting";
const TING_FONT = "bold 15px system-ui, sans-serif";
const TING_FILL = "#bae6fd";
const TING_ABOVE = 14;
const ting: TingLook = { ring: 0, ringAlpha: 0, wordAlpha: 0, rise: 0 };
/** A shot: a glow this long behind its head with a bright core, world units (release 1's look). */
const SHOT_GLOW_LENGTH = 28;
const SHOT_GLOW_WIDTH = 14;
const SHOT_CORE_LENGTH = 18;
const SHOT_CORE_WIDTH = 2.4;
/** A review laser shot (#73): this many times longer, its glow wider, its core whiter and wider. */
const LASER_LENGTH = 3;
const LASER_GLOW_WIDTH = 18;
const LASER_CORE_WIDTH = 3.2;
const LASER_CORE = "#ffffff";
/** A CI drone's shot (#84): release 1's, this much of a gun shot's size, violet. */
const DRONE_SHOT_SCALE = 0.8;
/** A floor pickup: its halo's radius (pickup radii) and pulse (cycles a second), and its disc. */
const PICKUP_HALO = 2.6;
const PICKUP_HALO_HZ = 1.2;
const PICKUP_DISC = "rgba(5, 7, 13, 0.85)";
const PICKUP_RIM_WIDTH = 2;
/** Your pickup timer icons: the disc behind each and the track its ring drains along. */
const ICON_DISC = "rgba(5, 7, 13, 0.7)";
const ICON_TRACK = "rgba(248, 250, 252, 0.18)";
const ICON_RING_WIDTH = 2.5;
/** The heat arc around your robot: its radius, width and the most it sweeps (270 degrees, open at the bottom). */
const HEAT_RADIUS = PLAYER_RADIUS + 8;
const HEAT_WIDTH = 3.5;
const HEAT_SWEEP = Math.PI * 1.5;
const HEAT_START = Math.PI * 0.75;
const HEAT_TRACK = "rgba(248, 250, 252, 0.14)";
const HEAT_COOL = "#fde047";
const HEAT_HOT = "#fb923c";
const HEAT_WARN_ON = "#f87171";
const HEAT_WARN_OFF = "#ffffff";
/** A dash's afterimage: this many ghosts along the dash, fading out over AFTERIMAGE_S. */
const AFTERIMAGE_GHOSTS = 4;
const AFTERIMAGE_S = 0.25;
/** The ghost nearest the robot starts this opaque, the farthest GHOST_FAR. */
const GHOST_NEAR = 0.45;
const GHOST_FAR = 0.1;
/** The dash cooldown ring on your robot: the bottom gap of the heat arc, filling as it cools. */
const DASH_RING_START = Math.PI * 0.3;
const DASH_RING_SWEEP = Math.PI * 0.4;
const DASH_READY = "#67e8f9";
const DASH_COOLING = "rgba(103, 232, 249, 0.55)";
const DASH_BUTTON_FILL = "rgba(5, 7, 13, 0.55)";
const DASH_BUTTON_TRACK = "rgba(248, 250, 252, 0.2)";
const DASH_BUTTON_WIDTH = 4;
const DASH_FONT = "bold 15px system-ui, sans-serif";
/** A robot that can't be hit blinks this fast, cycles a second. */
const BLINK_HZ = 8;
/**
 * A spawn-protected robot's shimmer: two white glows, half a cycle apart, each swelling between
 * these radii (robot radii) and alphas this many times a second, so the halo ripples outward
 * instead of blinking.
 */
const SHIMMER_HZ = 1.5;
const SHIMMER_MIN = 2.2;
const SHIMMER_MAX = 4;
const SHIMMER_ALPHA_MIN = 0.35;
const SHIMMER_ALPHA_MAX = 0.9;
// The HUD line (#64): one line at the top, its middle at LINE_MIDDLE below the safe top margin.
const SCORE_FONT = "bold 26px system-ui, sans-serif";
const LINE_FONT = "bold 18px system-ui, sans-serif";
const LOST_FONT = "bold 15px system-ui, sans-serif";
const LINE_MIDDLE = 14;
/** "streak lost" flicks up under the score, CSS px below the line's middle. */
const LOST_BELOW = 26;
/** The F readout's top, CSS px below the line's middle. */
const STATS_BELOW = 44;
/** The score's half height with its stroke, CSS px at the line's scale 1: the HUD band's bottom (#90). */
const SCORE_HALF = 15;
const MULT_ON = "#fde047";
const MULT_OFF = "#94a3b8";
const LOST_FILL = "#f87171";
const LINE_DIM = "#cbd5e1";
const PIP_FULL = "#f8fafc";
const PIP_EMPTY = "rgba(248, 250, 252, 0.25)";
const HIT_EDGE = "rgba(248, 113, 113, 1)";
// Down and revive (#59).
/** A downed robot's body: shrunk and squashed, flickering between these alphas. */
const DOWN_SCALE = 0.85;
const DOWN_SQUASH = 0.7;
const DOWN_ALPHA_ON = 0.85;
const DOWN_ALPHA_OFF = 0.35;
const DOWN_FLICKER_HZ = 5;
/** The countdown ring around a downed robot, world units. */
const COUNTDOWN_RADIUS = PLAYER_RADIUS + 10;
const COUNTDOWN_WIDTH = 3;
const COUNTDOWN_TRACK = "rgba(248, 250, 252, 0.18)";
const HELP_FILL = "#f87171";
const HELP_FONT = "bold 15px system-ui, sans-serif";
const HELP_TEXT = "HELP";
const REVIVE_WIDTH = 4;
/** The revive ring is never smaller than this, world units, so it clears the countdown ring. */
const REVIVE_MIN_RADIUS = COUNTDOWN_RADIUS + 9;
const REVIVE_TRACK = "rgba(248, 250, 252, 0.15)";
/** The edge arrow: a triangle this long and wide, CSS px. */
const ARROW_LENGTH = 26;
const ARROW_WIDTH = 20;
const DOWN_FONT = "bold 40px system-ui, sans-serif";
const DOWN_HINT_FONT = "bold 16px system-ui, sans-serif";
/** The DOWN line, CSS px below the screen's centre (under your robot), and its hint below it. */
const DOWN_BELOW = 70;
const DOWN_HINT = "A player next to you revives you";
// The hive queen (#85).
const QUEEN_COLOUR = PALETTE[GLOW_QUEEN];
/** Her marker on the floor: a ring this many queen radii across, pulsing, with a countdown arc. */
const MARKER_RADIUS = QUEEN_RADIUS * 1.6;
const MARKER_WIDTH = 5;
const QUEEN_LABEL = "Hive queen";
const QUEEN_LABEL_FONT = "bold 12px system-ui, sans-serif";
const QUEEN_BAR_TRACK = "rgba(5, 7, 13, 0.7)";
const QUEEN_BAR_EDGE = "rgba(248, 250, 252, 0.35)";
/** The arrow to her: larger than a downed player's, in her colour, CSS px. */
const QUEEN_ARROW_LENGTH = 34;
const QUEEN_ARROW_WIDTH = 28;
/** Her minimap mark, CSS px: at least twice a player dot (MINIMAP_DOT), ringed in white while she lives. */
const QUEEN_MAP_DOT = 6;
const QUEEN_MAP_RING = "#ffffff";
const BANNER_FONT = "bold 30px system-ui, sans-serif";
const BANNER_SUB_FONT = "bold 18px system-ui, sans-serif";
const BANNER_COMING = "The hive queen is coming";
const BANNER_DOWN = "Queen down!";
/** The banners stay this far inside the safe edges, CSS px, and their second line this far under the first. */
const BANNER_MARGIN = 16;
const BANNER_SUB_BELOW = 30;

/**
 * One robot to draw, world units. `inv`: untouchable, so it blinks. `prot`: spawn-protected (a
 * soft shimmer, not the blink). `dashing`: in a dash now. `dashAt`: when its last dash began,
 * scene seconds (-1: never), from `dashFromX, dashFromY`. `down`: waiting for a revive, with
 * `left` seconds before bleeding out, `rev` (0 to 1) of a revive by player `revBy` (0: none).
 * `bot`: a server fill bot, drawn with a BOT pill at `tag` (its width 0 until first measured).
 * `fx`: its active pickups, bit i for PICKUP_IDS[i] (#73).
 */
export type Robot = {
  id: number;
  x: number;
  y: number;
  aim: number;
  team: Team;
  name: string;
  trail: Trail;
  inv: boolean;
  prot: boolean;
  dashing: boolean;
  dashAt: number;
  dashFromX: number;
  dashFromY: number;
  down: boolean;
  left: number;
  rev: number;
  revBy: number;
  bot: boolean;
  tag: TagBox;
  fx: number;
};

/** The pickups on the floor to draw this frame, world units, filled by game.ts: kind (an index in PICKUP_IDS) and seconds left. */
export type FloorView = {
  x: Float32Array;
  y: Float32Array;
  kind: Uint8Array;
  left: Float32Array;
  count: number;
};

/**
 * The bugs to draw this frame, world units, in typed arrays filled by main.ts: where each is, the
 * way it faces, its leg animation offset (0 to 1), its kind's index in BUG_KINDS, and (v6) its
 * phase (an index into its kind's phases), the angle that phase locked (radians) and the seconds
 * it has been in that phase.
 */
export type BugsView = {
  x: Float32Array;
  y: Float32Array;
  heading: Float32Array;
  anim: Float32Array;
  kind: Uint8Array;
  phase: Uint8Array;
  angle: Float32Array;
  phaseS: Float32Array;
  count: number;
};

/** Everything a frame draws besides the camera. */
export type Scene = {
  robots: readonly Robot[];
  count: number;
  /** Your robot's index in `robots`, or -1 (out, or not yet in). */
  self: number;
  /** Seconds, for pulses and leg frames. */
  t: number;
  bugs: BugsView;
  floor: FloorView;
  shots: ClientShots;
  /** The ticks shots are drawn at: yours, and everyone else's. */
  mineAt: number;
  othersAt: number;
  you: number | null;
  particles: Particles;
  /** Refactor bombs going off (#78). */
  rings: Rings;
  texts: Texts;
  /** Shots a beetle's shell blocked, ringing (#80). */
  tings: Tings;
  shake: Shake;
  /** Your numbers, or null before the first snapshot. */
  me: SnapshotMe | null;
  wave: number;
  hud: HudFx;
  /** Players in your arena, you and bots included. */
  players: number;
  /** Your life is over (the life-over screen is up): no HUD, no dash button. */
  out: boolean;
  /**
   * Watching behind the start screen (#79): the arena and its effects only, nothing on top: no
   * hit flash, HUD line, minimap, sticks, dash button, edge arrows or F readout.
   */
  watch: boolean;
  sticks: readonly Stick[];
  stats: string | null;
  /** The dash button, CSS px, while you are in a life; else null. */
  dashButton: DashButton | null;
  /** How far your dash has cooled, 0 to 1 (1: ready). */
  dashReady: number;
  /** The hive queen from the newest snapshot (#85): [] none, her marker, or her alive. */
  queen: SnapshotQueen;
  /** "Queen down!" (#85) and the name of who dealt the most ("" for no name). */
  banner: Banner;
  bannerName: string;
};

type TeamSprites = { body: HTMLCanvasElement; glow: HTMLCanvasElement };

const scoreFormat = new Intl.NumberFormat("en-US");
/** The glob's index in BUG_KINDS (#72): left off the minimap. */
const GLOB_KIND = BUG_KINDS.indexOf("glob");

export function createArenaRenderer(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  let dpr = 1;
  let cssW = 1;
  let cssH = 1;
  let ppu = 0;
  let teams: Record<Team, TeamSprites> | null = null;
  let white: HTMLCanvasElement | null = null;
  let glows: HTMLCanvasElement[] = [];
  // Each bug kind's leg frames and glow, by its index in BUG_KINDS.
  let bugFrames: HTMLCanvasElement[][] = [];
  let bugGlows: HTMLCanvasElement[] = [];
  const bugFrame: BugFrame = {
    ctx,
    k: 1,
    ox: 0,
    oy: 0,
    t: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    screenLeft: 0,
    screenTop: 0,
    screenRight: 0,
    screenBottom: 0,
    frames: [],
    glow: document.createElement("canvas"),
  };
  let mark: HTMLCanvasElement | null = null;
  let floor: CanvasPattern | null = null;
  let vignette: HTMLCanvasElement | null = null;
  let minimap: MinimapLayout = minimapLayout(1, 1, { top: 0, right: 0, bottom: 0, left: 0 });
  let hud = hudLayout(1, { top: 0, right: 0, bottom: 0, left: 0 });
  const safe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const arrow: EdgeArrow = { x: 0, y: 0, angle: 0 };
  const knob = { x: 0, y: 0 };
  const dot = { x: 0, y: 0 };
  // HUD strings and their widths, measured only when a value changes; the line is laid out again then.
  let scoreShown = -1;
  let scoreText = "";
  let multShown = -1;
  let waveShown = -1;
  let playersShown = -1;
  let multStr = "";
  let waveLong = "";
  let waveShort = "";
  let playersLong = "";
  let playersShort = "";
  const widths: HudWidths = { score: 0, mult: 0, wave: 0, waveShort: 0, players: 0, playersShort: 0 };
  const line = createHudLine();
  /** Where the name tag and HELP go this frame (#90), reused for every robot. */
  const spot: TagSpot = { name: 0, help: 0 };
  let lineDirty = true;
  const downTexts = new Map<number, string>();
  // The hive queen's bar and banners (#85): laid out per frame into these, texts measured on change.
  const bar: QueenBar = { x: 0, labelY: 0, y: 0, w: 0 };
  const marker: MarkerLook = { pulse: 0, left: 0 };
  const arrowSafe: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  let bannerFor = "";
  let bannerSub = "";
  let comingW = 0;
  let downW = 0;
  let subW = 0;
  // The view plus a margin for halos and names, world units: set at the start of each frame.
  let vl = 0;
  let vt = 0;
  let vr = 0;
  let vb = 0;
  let sl = 0;
  let st = 0;
  let sr = 0;
  let sb = 0;
  const inView = (x: number, y: number) => x > vl && x < vr && y > vt && y < vb;

  const downText = (sec: number) => {
    let s = downTexts.get(sec);
    if (s === undefined) downTexts.set(sec, (s = "DOWN " + sec));
    return s;
  };
  /** Measures what changed and lays the line out again; nothing when nothing changed. */
  const measureLine = (score: number, mult: number, wave: number, players: number) => {
    if (score !== scoreShown) {
      scoreShown = score;
      scoreText = scoreFormat.format(score);
      ctx.font = SCORE_FONT;
      widths.score = ctx.measureText(scoreText).width;
      lineDirty = true;
    }
    ctx.font = LINE_FONT;
    if (mult !== multShown) {
      multShown = mult;
      multStr = `x${mult}`;
      widths.mult = ctx.measureText(multStr).width;
      lineDirty = true;
    }
    if (wave !== waveShown) {
      waveShown = wave;
      waveLong = `Wave ${wave}`;
      waveShort = `W${wave}`;
      widths.wave = ctx.measureText(waveLong).width;
      widths.waveShort = ctx.measureText(waveShort).width;
      lineDirty = true;
    }
    if (players !== playersShown) {
      playersShown = players;
      playersLong = `${players} playing`;
      playersShort = String(players);
      widths.players = ctx.measureText(playersLong).width;
      widths.playersShort = ctx.measureText(playersShort).width;
      lineDirty = true;
    }
    if (lineDirty) {
      layoutHudLine(hud.left, minimap.x, widths, line);
      lineDirty = false;
    }
  };

  /** The canvas is `w` x `h` CSS px at `newDpr`; the camera's scale is CSS px per unit. */
  function resize(w: number, h: number, newDpr: number, cam: Camera, insets: Insets): void {
    cssW = w;
    cssH = h;
    dpr = newDpr;
    minimap = minimapLayout(w, h, insets);
    hud = hudLayout(w, insets);
    lineDirty = true;
    Object.assign(safe, insets);
    const k = dpr * cam.scale;
    if (teams && Math.abs(k - ppu) < 0.01) return;
    ppu = k;
    teams = {
      tabs: { body: buildRobot(ppu, TEAM_LOOK.tabs.color), glow: buildGlow(TEAM_LOOK.tabs.color) },
      spaces: { body: buildRobot(ppu, TEAM_LOOK.spaces.color), glow: buildGlow(TEAM_LOOK.spaces.color) },
    };
    glows = PALETTE.map((c) => buildGlow(c));
    white = glows[GLOW_WHITE]!;
    bugFrames = BUG_KINDS.map((kind) => buildBugLookSprites(BUG_DRAW[kind].look, ppu));
    bugGlows = BUG_KINDS.map((kind) => glows[BUG_DRAW[kind].look.glow]!);
    mark = robotMarkSprite(ppu);
    const tile = floorTile(ppu, TILE);
    floor = ctx.createPattern(tile, "repeat");
    floor?.setTransform(new DOMMatrix().scale(TILE / tile.width, TILE / tile.height));
    // A screen-space vignette, like release 1's floor has, built once per size.
    vignette = document.createElement("canvas");
    vignette.width = Math.max(1, Math.round(w * dpr));
    vignette.height = Math.max(1, Math.round(h * dpr));
    const v = vignette.getContext("2d");
    if (v) {
      const cx = vignette.width / 2;
      const cy = vignette.height / 2;
      const g = v.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.6, cx, cy, Math.hypot(cx, cy));
      g.addColorStop(0, "rgba(0, 0, 0, 0)");
      g.addColorStop(1, VIGNETTE);
      v.fillStyle = g;
      v.fillRect(0, 0, vignette.width, vignette.height);
    }
  }

  /** A downed robot: no trail and no barrel, the body slumped and flickering, in its countdown ring. */
  function drawDowned(r: Robot, t: number): void {
    const ts = teams![r.team];
    ctx.lineWidth = COUNTDOWN_WIDTH;
    ctx.strokeStyle = COUNTDOWN_TRACK;
    ctx.beginPath();
    ctx.arc(r.x, r.y, COUNTDOWN_RADIUS, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = HELP_FILL;
    ctx.beginPath();
    ctx.arc(r.x, r.y, COUNTDOWN_RADIUS, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, Math.max(0, r.left / DOWN_S)));
    ctx.stroke();
    const rh = PLAYER_RADIUS * ROBOT_SPRITE_HALF * DOWN_SCALE;
    ctx.globalAlpha = flashOn(t + r.id * 0.37, DOWN_FLICKER_HZ) ? DOWN_ALPHA_ON : DOWN_ALPHA_OFF;
    ctx.drawImage(ts.body, r.x - rh, r.y - rh * DOWN_SQUASH + PLAYER_RADIUS * 0.2, rh * 2, rh * 2 * DOWN_SQUASH);
    ctx.globalAlpha = 1;
  }

  /** The revive's progress: a ring around the downed robot and its reviver, filling in the reviver's colour. */
  function drawRevive(r: Robot, robots: readonly Robot[], count: number): void {
    if (r.revBy === 0) return;
    let h: Robot | null = null;
    for (let i = 0; i < count; i++) if (robots[i]!.id === r.revBy) h = robots[i]!;
    if (!h) return;
    const mx = (r.x + h.x) / 2;
    const my = (r.y + h.y) / 2;
    const radius = Math.max(REVIVE_MIN_RADIUS, Math.hypot(h.x - r.x, h.y - r.y) / 2 + PLAYER_RADIUS);
    ctx.lineWidth = REVIVE_WIDTH;
    ctx.strokeStyle = REVIVE_TRACK;
    ctx.beginPath();
    ctx.arc(mx, my, radius, 0, TAU);
    ctx.stroke();
    if (r.rev <= 0) return;
    ctx.lineCap = "round";
    ctx.strokeStyle = TEAM_LOOK[h.team].color;
    ctx.beginPath();
    ctx.arc(mx, my, radius, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, r.rev));
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  function drawRobot(r: Robot, t: number): void {
    if (r.down) {
      drawDowned(r, t);
      return;
    }
    const ts = teams![r.team];
    // Trail, newest first, skipping the point under the robot.
    ctx.globalCompositeOperation = "lighter";
    const trail = r.trail;
    for (let n = 1; n < trail.count; n++) {
      const i = trailSlot(trail, n);
      const life = 1 - trail.age[i]! / TRAIL_SECONDS;
      if (life <= 0) continue;
      const size = PLAYER_RADIUS * (0.6 + 0.9 * life);
      ctx.globalAlpha = 0.45 * life;
      ctx.drawImage(ts.glow, trail.x[i]! - size, trail.y[i]! - size, size * 2, size * 2);
    }
    // Spawn protection: a soft white shimmer rippling around the body, drawn under it. It never
    // blinks the body, so it reads apart from the hit blink below.
    if (r.prot) {
      for (let w = 0; w < 2; w++) {
        const k = 0.5 + 0.5 * Math.sin(t * TAU * SHIMMER_HZ + r.id + w * Math.PI);
        const size = PLAYER_RADIUS * (SHIMMER_MIN + (SHIMMER_MAX - SHIMMER_MIN) * k);
        ctx.globalAlpha = SHIMMER_ALPHA_MAX - (SHIMMER_ALPHA_MAX - SHIMMER_ALPHA_MIN) * k;
        ctx.drawImage(white!, r.x - size, r.y - size, size * 2, size * 2);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // A dash's afterimage: ghosts of the body along the dash, fainter the farther back, fading out.
    const since = t - r.dashAt;
    if (r.dashAt >= 0 && since < AFTERIMAGE_S) {
      const fade = 1 - since / AFTERIMAGE_S;
      const rh = PLAYER_RADIUS * ROBOT_SPRITE_HALF;
      const gs = PLAYER_RADIUS * 1.3;
      for (let g = 0; g < AFTERIMAGE_GHOSTS; g++) {
        // g = 0 at the start of the dash, the last one just behind the robot.
        const f = g / AFTERIMAGE_GHOSTS;
        const gx = r.dashFromX + (r.x - r.dashFromX) * f;
        const gy = r.dashFromY + (r.y - r.dashFromY) * f;
        const alpha = fade * (GHOST_FAR + (GHOST_NEAR - GHOST_FAR) * f);
        ctx.globalAlpha = alpha;
        ctx.drawImage(ts.body, gx - rh, gy - rh, rh * 2, rh * 2);
        ctx.globalCompositeOperation = "lighter";
        ctx.drawImage(ts.glow, gx - gs, gy - gs, gs * 2, gs * 2);
        ctx.globalCompositeOperation = "source-over";
      }
      ctx.globalAlpha = 1;
    }
    // Untouchable: the body blinks (the trail, halo and ring stay, so you never lose it).
    if (r.inv && !flashOn(t, BLINK_HZ)) return;
    // The barrel under the body, so it reads as coming out of it.
    ctx.save();
    ctx.translate(r.x, r.y);
    ctx.rotate(r.aim);
    ctx.fillStyle = BARREL_COLOUR;
    ctx.beginPath();
    ctx.roundRect(PLAYER_RADIUS * 0.6, -BARREL_WIDTH / 2, PLAYER_RADIUS * 0.4 + BARREL_LENGTH, BARREL_WIDTH, BARREL_WIDTH / 2);
    ctx.fill();
    ctx.restore();
    const rh = PLAYER_RADIUS * ROBOT_SPRITE_HALF;
    ctx.drawImage(ts.body, r.x - rh, r.y - rh, rh * 2, rh * 2);
    ctx.globalCompositeOperation = "lighter";
    const core = PLAYER_RADIUS * (1.05 + 0.12 * Math.sin(t * 8 + r.id));
    ctx.drawImage(ts.glow, r.x - core, r.y - core, core * 2, core * 2);
    const hot = PLAYER_RADIUS * 0.45;
    ctx.drawImage(white!, r.x - hot, r.y - hot, hot * 2, hot * 2);
    ctx.globalCompositeOperation = "source-over";
  }

  /** A robot's name (NAME_FONT set, centred) with its baseline at `y`; a bot's dimmer, with its BOT pill to the left. */
  function drawName(r: Robot, y: number): void {
    if (!r.bot) {
      ctx.strokeText(r.name, r.x, y);
      ctx.fillText(r.name, r.x, y);
      return;
    }
    if (r.tag.w === 0) {
      // Measured once per robot, not per frame.
      const nameW = ctx.measureText(r.name).width;
      ctx.font = BOT_TAG_FONT;
      botTagBox(nameW, ctx.measureText(BOT_TAG).width, r.tag);
      ctx.font = NAME_FONT;
    }
    const nameFill = ctx.fillStyle;
    ctx.globalAlpha = BOT_NAME_ALPHA;
    ctx.strokeText(r.name, r.x, y);
    ctx.fillText(r.name, r.x, y);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BOT_TAG_FILL;
    ctx.beginPath();
    ctx.roundRect(r.x + r.tag.x, y - BOT_TAG_TOP, r.tag.w, BOT_TAG_H, 3);
    ctx.fill();
    ctx.font = BOT_TAG_FONT;
    ctx.fillStyle = BOT_TAG_TEXT;
    ctx.fillText(BOT_TAG, r.x + r.tag.x + r.tag.w / 2, y - BOT_TAG_BASE);
    ctx.font = NAME_FONT;
    ctx.fillStyle = nameFill;
  }

  function drawStick(s: Stick): void {
    if (!s.active) return;
    ctx.strokeStyle = STICK_RING;
    ctx.lineWidth = STICK_RING_WIDTH;
    ctx.beginPath();
    ctx.arc(s.cx, s.cy, STICK_RANGE, 0, TAU);
    ctx.stroke();
    stickKnob(s, knob);
    ctx.fillStyle = STICK_KNOB;
    ctx.beginPath();
    ctx.arc(knob.x, knob.y, STICK_KNOB_RADIUS, 0, TAU);
    ctx.fill();
  }

  /** Every floor pickup in view: a pulsing halo in its glow, a dark disc with a rim, its glyph; blinking near its end. */
  function drawFloor(f: FloorView, t: number): void {
    for (let i = 0; i < f.count; i++) {
      const x = f.x[i]!;
      const y = f.y[i]!;
      if (!inView(x, y)) continue;
      const d = PICKUP_DRAW[PICKUP_IDS[f.kind[i]!]!];
      if (!d) continue;
      const alpha = floorAlpha(f.left[i]!);
      const k = 0.5 + 0.5 * Math.sin(t * TAU * PICKUP_HALO_HZ + i);
      const h = PICKUP_RADIUS * PICKUP_HALO * (0.85 + 0.15 * k);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = alpha * (0.6 + 0.3 * k);
      ctx.drawImage(glows[d.glow]!, x - h, y - h, h * 2, h * 2);
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = alpha;
      ctx.fillStyle = PICKUP_DISC;
      ctx.beginPath();
      ctx.arc(x, y, PICKUP_RADIUS, 0, TAU);
      ctx.fill();
      ctx.lineWidth = PICKUP_RIM_WIDTH;
      ctx.strokeStyle = PALETTE[d.glow]!;
      ctx.stroke();
      d.glyph(ctx, x, y, PICKUP_RADIUS * 1.25);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * What each robot's active pickups draw on it (a shield bubble, a laser's barrel glow, a CI
   * drone), for everyone, at `tick`: the tick that robot's shots are drawn at.
   */
  function drawEffects(r: Robot, t: number, tick: number): void {
    if (r.fx === 0 || r.down) return;
    for (let i = 0; i < PICKUP_IDS.length; i++) {
      if (!(r.fx & (1 << i))) continue;
      const d = PICKUP_DRAW[PICKUP_IDS[i]!];
      d.on?.(ctx, r.x, r.y, r.aim, t, glows[d.glow]!, r.id, tick);
    }
  }

  /** Every bug: first what each kind draws under the bodies (aim lines), then the bodies in view. */
  function drawBugs(b: BugsView, t: number, k: number, ox: number, oy: number): void {
    const f = bugFrame;
    f.k = k;
    f.ox = ox;
    f.oy = oy;
    f.t = t;
    f.left = vl;
    f.top = vt;
    f.right = vr;
    f.bottom = vb;
    f.screenLeft = sl;
    f.screenTop = st;
    f.screenRight = sr;
    f.screenBottom = sb;
    for (let i = 0; i < b.count; i++) {
      const kind = b.kind[i]!;
      const d = BUG_DRAW[BUG_KINDS[kind] as BugKind];
      if (!d?.under) continue;
      f.frames = bugFrames[kind]!;
      f.glow = bugGlows[kind]!;
      d.under(f, b, i);
    }
    for (let i = 0; i < b.count; i++) {
      if (!inView(b.x[i]!, b.y[i]!)) continue;
      const kind = b.kind[i]!;
      const d = BUG_DRAW[BUG_KINDS[kind] as BugKind];
      if (!d) continue;
      f.frames = bugFrames[kind]!;
      f.glow = bugGlows[kind]!;
      d.draw(f, b, i);
    }
  }

  function drawShots(sc: Scene, k: number, ox: number, oy: number): void {
    const s = sc.shots;
    if (s.live === 0) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = SHOT_CORE;
    const glow = glows[GLOW_SHOT]!;
    const beam = glows[GLOW_LASER]!;
    const violet = glows[GLOW_DRONE]!;
    for (let i = 0; i < s.used.length; i++) {
      if (!s.used[i]) continue;
      const travel = shotTravel(s, i, s.owner[i] === sc.you ? sc.mineAt : sc.othersAt);
      if (travel < 0) continue;
      const dx = s.dx[i]!;
      const dy = s.dy[i]!;
      const x = s.x0[i]! + dx * travel;
      const y = s.y0[i]! + dy * travel;
      if (!inView(x, y)) continue;
      ctx.setTransform(k * dx, k * dy, -k * dy, k * dx, k * x + ox, k * y + oy);
      if (s.laser[i]) {
        // A review laser shot: a beam three times as long, in the laser's glow, twice over, with a white core.
        const tail = Math.min(SHOT_GLOW_LENGTH * LASER_LENGTH, travel + 6);
        const core = Math.min(SHOT_CORE_LENGTH * LASER_LENGTH, travel + 2);
        ctx.drawImage(beam, 6 - tail, -LASER_GLOW_WIDTH / 2, tail, LASER_GLOW_WIDTH);
        ctx.drawImage(beam, 6 - tail, -LASER_GLOW_WIDTH / 4, tail, LASER_GLOW_WIDTH / 2);
        ctx.fillStyle = LASER_CORE;
        ctx.fillRect(2 - core, -LASER_CORE_WIDTH / 2, core, LASER_CORE_WIDTH);
        ctx.fillStyle = SHOT_CORE;
        continue;
      }
      if (s.drone[i]) {
        // A CI drone's shot (#84): release 1's, a little shorter and narrower, violet through.
        const d = DRONE_SHOT_SCALE;
        const tail = Math.min(SHOT_GLOW_LENGTH * d, travel + 6 * d);
        const core = Math.min(SHOT_CORE_LENGTH * d, travel + 2 * d);
        ctx.drawImage(violet, 6 * d - tail, (-SHOT_GLOW_WIDTH * d) / 2, tail, SHOT_GLOW_WIDTH * d);
        ctx.fillStyle = DRONE_SHOT_CORE;
        ctx.fillRect(2 * d - core, (-SHOT_CORE_WIDTH * d) / 2, core, SHOT_CORE_WIDTH * d);
        ctx.fillStyle = SHOT_CORE;
        continue;
      }
      // The streak never reaches back behind the barrel.
      const tail = Math.min(SHOT_GLOW_LENGTH, travel + 6);
      const core = Math.min(SHOT_CORE_LENGTH, travel + 2);
      ctx.drawImage(glow, 6 - tail, -SHOT_GLOW_WIDTH / 2, tail, SHOT_GLOW_WIDTH);
      ctx.fillRect(2 - core, -SHOT_CORE_WIDTH / 2, core, SHOT_CORE_WIDTH);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function drawParticles(p: Particles): void {
    if (p.live === 0) return;
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < p.life.length; i++) {
      const life = p.life[i]!;
      if (life <= 0) continue;
      const l = life / p.maxLife[i]!;
      const size = PARTICLE_SIZE * (0.4 + 0.6 * l);
      ctx.globalAlpha = l;
      ctx.drawImage(glows[p.colour[i]!]!, p.x[i]! - size, p.y[i]! - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  /** The rings of shots a beetle's shell blocked (#80), in world units. */
  function drawTingRings(tg: Tings): void {
    if (tg.live === 0) return;
    ctx.strokeStyle = TING_RING;
    ctx.lineWidth = 2;
    for (let i = 0; i < tg.age.length; i++) {
      if (tg.age[i]! >= TING_S) continue;
      tingLook(tg.age[i]!, ting);
      if (ting.ringAlpha <= 0) continue;
      ctx.globalAlpha = ting.ringAlpha;
      ctx.beginPath();
      ctx.arc(tg.x[i]!, tg.y[i]!, ting.ring, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  const ring: RingAt = { radius: 0, alpha: 0 };

  /**
   * Refactor bombs going off (#78), release 1's ring: a stroke in the bomb's colour sweeping out
   * to the bomb's reach, drawn wide and faint for its glow, then bright, fading near the end.
   */
  function drawRings(r: Rings): void {
    if (r.live === 0) return;
    ctx.strokeStyle = BOMB_RING;
    for (let i = 0; i < r.age.length; i++) {
      if (!ringAt(r.age[i]!, r.radius[i]!, ring)) continue;
      const x = r.x[i]!;
      const y = r.y[i]!;
      const reach = ring.radius + BOMB_RING_GLOW_WIDTH;
      if (x + reach < vl || x - reach > vr || y + reach < vt || y - reach > vb) continue;
      ctx.beginPath();
      ctx.arc(x, y, ring.radius, 0, TAU);
      ctx.globalAlpha = BOMB_RING_GLOW_ALPHA * ring.alpha;
      ctx.lineWidth = BOMB_RING_GLOW_WIDTH;
      ctx.stroke();
      ctx.globalAlpha = ring.alpha;
      ctx.lineWidth = BOMB_RING_WIDTH;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** The hive queen's marker while she arrives (#85): a pulsing ring on the floor, its countdown arc emptying. */
  function drawMarker(q: SnapshotQueen, t: number): void {
    if (q.length === 0 || q[0] !== 0) return;
    const x = q[1];
    const y = q[2];
    const reach = MARKER_RADIUS * 1.6;
    if (x + reach < vl || x - reach > vr || y + reach < vt || y - reach > vb) return;
    markerLook(q[3], t, marker);
    const r = MARKER_RADIUS * (1 + 0.12 * marker.pulse);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.35 + 0.45 * marker.pulse;
    const g = r * 1.5;
    ctx.drawImage(glows[GLOW_QUEEN]!, x - g, y - g, g * 2, g * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 0.5 + 0.5 * marker.pulse;
    ctx.strokeStyle = QUEEN_COLOUR;
    ctx.lineWidth = MARKER_WIDTH;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = MARKER_WIDTH * 1.6;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.6, -Math.PI / 2, -Math.PI / 2 + TAU * marker.left);
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  /** Text `s` centred at `x`, `y` in `font`, scaled down to fit `maxW` (`w`: its width at full size). */
  function drawFitted(s: string, w: number, font: string, x: number, y: number, maxW: number): void {
    const sc = fitScale(w, maxW);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(sc, sc);
    ctx.font = font;
    ctx.strokeText(s, 0, 0);
    ctx.fillText(s, 0, 0);
    ctx.restore();
  }

  /**
   * The hive queen's HUD (#85): her health bar under the line while she lives, and the banners:
   * "The hive queen is coming" while her marker shows, "Queen down!" naming who dealt the most for
   * a few seconds after her kill. Banner texts are measured only when they change.
   */
  function drawQueenHud(sc: Scene, lineY: number, icons: number): void {
    const q = sc.queen;
    if (q.length > 0 && q[0] === 1) {
      queenBarLayout(hud.left, lineY, minimap.x, icons, bar);
      if (bar.w > 0) {
        ctx.font = QUEEN_LABEL_FONT;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.lineWidth = 3;
        ctx.strokeStyle = TEXT_STROKE;
        ctx.fillStyle = QUEEN_COLOUR;
        ctx.strokeText(QUEEN_LABEL, bar.x, bar.labelY);
        ctx.fillText(QUEEN_LABEL, bar.x, bar.labelY);
        ctx.fillStyle = QUEEN_BAR_TRACK;
        ctx.fillRect(bar.x, bar.y, bar.w, QUEEN_BAR_H);
        ctx.fillStyle = QUEEN_COLOUR;
        ctx.fillRect(bar.x, bar.y, bar.w * barFill(q[4], q[5]), QUEEN_BAR_H);
        ctx.strokeStyle = QUEEN_BAR_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(bar.x, bar.y, bar.w, QUEEN_BAR_H);
      }
    }
    const coming = q.length > 0 && q[0] === 0;
    const downAlpha = bannerAlpha(sc.banner.left);
    if (!coming && downAlpha <= 0) return;
    const maxW = cssW - safe.left - safe.right - 2 * BANNER_MARGIN;
    const cx = safe.left + (cssW - safe.left - safe.right) / 2;
    if (comingW === 0) {
      ctx.font = BANNER_FONT;
      comingW = ctx.measureText(BANNER_COMING).width;
      downW = ctx.measureText(BANNER_DOWN).width;
    }
    if (sc.bannerName !== bannerFor) {
      bannerFor = sc.bannerName;
      bannerSub = bannerFor ? `${bannerFor} dealt the most` : "";
      ctx.font = BANNER_SUB_FONT;
      subW = bannerSub ? ctx.measureText(bannerSub).width : 0;
    }
    const halfW = Math.min(maxW, coming ? comingW : Math.max(downW, subW)) / 2 + BANNER_MARGIN;
    const hudBottom = hud.top + LINE_MIDDLE + barShift(sc) + LOST_BELOW + hudIconsShift(iconCount(sc.me)) + BANNER_MARGIN * 2;
    const y = bannerY(cssH, bannerFloor(cx, halfW, minimap.x, minimap.y + minimap.size + BANNER_MARGIN * 2, hudBottom, BANNER_MARGIN));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 5;
    ctx.strokeStyle = TEXT_STROKE;
    if (coming) {
      ctx.globalAlpha = 0.75 + 0.25 * Math.sin(sc.t * TAU * 2);
      ctx.fillStyle = QUEEN_COLOUR;
      drawFitted(BANNER_COMING, comingW, BANNER_FONT, cx, y, maxW);
      ctx.globalAlpha = 1;
      return;
    }
    ctx.globalAlpha = downAlpha;
    ctx.fillStyle = QUEEN_COLOUR;
    drawFitted(BANNER_DOWN, downW, BANNER_FONT, cx, y, maxW);
    if (bannerSub) {
      ctx.fillStyle = TEXT_FILL;
      ctx.lineWidth = 4;
      drawFitted(bannerSub, subW, BANNER_SUB_FONT, cx, y + BANNER_SUB_BELOW, maxW);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The arrow at the screen's edge to the hive queen while she is off screen, at any distance (#85),
   * kept below the minimap's bottom so the HUD line, her bar and the minimap stay clear.
   */
  function drawQueenArrow(cam: Camera, q: SnapshotQueen, t: number): void {
    if (q.length === 0 || q[0] !== 1) return;
    // Never in the top band: it stays below the minimap, so it covers neither the HUD line, her bar nor the minimap.
    arrowSafe.left = safe.left;
    arrowSafe.right = safe.right;
    arrowSafe.bottom = safe.bottom;
    arrowSafe.top = Math.max(safe.top, minimap.y + minimap.size);
    if (!edgeArrow(cam, cssW, cssH, arrowSafe, cam.x, cam.y, q[2], q[3], arrow, Infinity)) return;
    ctx.save();
    ctx.translate(arrow.x, arrow.y);
    ctx.rotate(arrow.angle);
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = 0.5 + 0.2 * Math.sin(t * 5);
    const g = QUEEN_ARROW_LENGTH;
    ctx.drawImage(glows[GLOW_QUEEN]!, -g, -g, g * 2, g * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = QUEEN_COLOUR;
    ctx.strokeStyle = TEXT_STROKE;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(QUEEN_ARROW_LENGTH / 2, 0);
    ctx.lineTo(-QUEEN_ARROW_LENGTH / 2, -QUEEN_ARROW_WIDTH / 2);
    ctx.lineTo(-QUEEN_ARROW_LENGTH / 4, 0);
    ctx.lineTo(-QUEEN_ARROW_LENGTH / 2, QUEEN_ARROW_WIDTH / 2);
    ctx.closePath();
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  }

  /** Your gun's heat: an arc around your robot, open at the bottom, flashing near the lock. */
  function drawHeat(me: Robot, sm: SnapshotMe, t: number): void {
    const locked = sm.lk === 1;
    if (sm.he <= 0.005 && !locked) return;
    ctx.lineCap = "round";
    ctx.lineWidth = HEAT_WIDTH;
    ctx.strokeStyle = HEAT_TRACK;
    ctx.beginPath();
    ctx.arc(me.x, me.y, HEAT_RADIUS, HEAT_START, HEAT_START + HEAT_SWEEP);
    ctx.stroke();
    const warn = heatWarning(sm.he, locked);
    ctx.strokeStyle = warn ? (flashOn(t) ? HEAT_WARN_ON : HEAT_WARN_OFF) : sm.he < 0.6 ? HEAT_COOL : HEAT_HOT;
    ctx.beginPath();
    ctx.arc(me.x, me.y, HEAT_RADIUS, HEAT_START, HEAT_START + HEAT_SWEEP * Math.min(1, sm.he));
    ctx.stroke();
    ctx.lineCap = "butt";
  }

  /** Your dash cooling: a short arc in the heat arc's bottom gap, filling up; gone once ready. */
  function drawDashRing(me: Robot, ready: number): void {
    if (ready >= 1) return;
    ctx.lineCap = "round";
    ctx.lineWidth = HEAT_WIDTH;
    ctx.strokeStyle = HEAT_TRACK;
    ctx.beginPath();
    ctx.arc(me.x, me.y, HEAT_RADIUS, DASH_RING_START, DASH_RING_START + DASH_RING_SWEEP);
    ctx.stroke();
    if (ready > 0) {
      ctx.strokeStyle = DASH_COOLING;
      ctx.beginPath();
      ctx.arc(me.x, me.y, HEAT_RADIUS, DASH_RING_START, DASH_RING_START + DASH_RING_SWEEP * ready);
      ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  /** The dash button, CSS px: a round button with a cooldown sweep around its edge, bright when ready. */
  function drawDashButton(b: DashButton, ready: number): void {
    const on = ready >= 1;
    ctx.fillStyle = DASH_BUTTON_FILL;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, TAU);
    ctx.fill();
    ctx.lineWidth = DASH_BUTTON_WIDTH;
    ctx.strokeStyle = DASH_BUTTON_TRACK;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r - DASH_BUTTON_WIDTH / 2, 0, TAU);
    ctx.stroke();
    if (ready > 0) {
      ctx.strokeStyle = on ? DASH_READY : DASH_COOLING;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r - DASH_BUTTON_WIDTH / 2, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, ready));
      ctx.stroke();
    }
    ctx.globalAlpha = on ? 1 : 0.5;
    ctx.font = DASH_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = on ? DASH_READY : TEXT_FILL;
    ctx.fillText("DASH", b.x, b.y + 1);
    ctx.globalAlpha = 1;
  }

  /** The person glyph of the line's short form: a head and shoulders, centred on `x`, `y`. */
  function drawGlyph(x: number, y: number): void {
    ctx.beginPath();
    ctx.arc(x, y - 4, 3.2, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y + 7, 5.5, Math.PI, TAU);
    ctx.fill();
  }

  /**
   * The bottom of the HUD band, CSS px (#90): the score's, or your pickup timers' while any show.
   * Name tags and HELP stay below it (tag.ts tagBaselines). The line's scale is the last frame's.
   */
  function hudBandBottom(icons: number): number {
    const below = icons > 0 ? HUD_ICONS_BELOW + HUD_ICON_SIZE / 2 + ICON_RING_WIDTH / 2 : SCORE_HALF * line.scale;
    return hud.top + LINE_MIDDLE + below;
  }

  /** How far what sits under the HUD line moves down for the hive queen's health bar (#85). */
  function barShift(sc: Scene): number {
    return sc.queen.length > 0 && sc.queen[0] === 1 ? QUEEN_BAR_SHIFT : 0;
  }

  /** Your active pickups (from `me.fx`), as many as there are, at most one per pickup. */
  function iconCount(me: SnapshotMe | null): number {
    if (!me || !me.fx) return 0;
    let n = 0;
    for (let i = 0; i < me.fx.length; i++) if (me.fx[i]! > 0) n++;
    return n;
  }

  /** Your pickup timers (#73): a disc with the pickup's glyph and a ring in its colour draining as it runs out. */
  function drawIcons(me: SnapshotMe, y: number): void {
    let n = 0;
    const r = HUD_ICON_SIZE / 2;
    for (let i = 0; i < me.fx.length; i++) {
      const left = me.fx[i]!;
      if (left <= 0) continue;
      const id = PICKUP_IDS[i]!;
      const d = PICKUP_DRAW[id];
      const x = hudIconX(hud.left, n++);
      ctx.fillStyle = ICON_DISC;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
      ctx.lineWidth = ICON_RING_WIDTH;
      ctx.strokeStyle = ICON_TRACK;
      ctx.stroke();
      ctx.strokeStyle = PALETTE[d.glow]!;
      ctx.beginPath();
      ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, left / pickupDef(id).durationTicks));
      ctx.stroke();
      d.glyph(ctx, x, y, HUD_ICON_SIZE * 0.6);
    }
  }

  /**
   * The HUD line: score and multiplier (pulsing when it rises), three hit pips (flashing as one
   * goes), the wave and the people in your arena (bots never counted, #90); your pickup timers under it (#73); "streak lost"
   * flicks up under the score (under the timers while any show). While down, DOWN and the seconds
   * left with one line on how to get up, under your robot (#59).
   */
  function drawHud(sc: Scene): void {
    const me = sc.me;
    if (!me) return;
    measureLine(me.sc, me.mu, sc.wave, sc.players);
    const y = hud.top + LINE_MIDDLE;
    ctx.save();
    ctx.translate(hud.left, y);
    ctx.scale(line.scale, line.scale);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = TEXT_STROKE;
    ctx.lineWidth = 4;
    ctx.font = SCORE_FONT;
    ctx.fillStyle = TEXT_FILL;
    ctx.strokeText(scoreText, 0, 0);
    ctx.fillText(scoreText, 0, 0);
    // The multiplier, pulsing from its left edge when it goes up.
    const pulse = pulseScale(sc.hud);
    ctx.save();
    ctx.translate(line.mult, 0);
    ctx.scale(pulse, pulse);
    ctx.font = LINE_FONT;
    ctx.fillStyle = me.mu > 1 ? MULT_ON : MULT_OFF;
    ctx.strokeText(multStr, 0, 0);
    ctx.fillText(multStr, 0, 0);
    ctx.restore();
    // Hits left.
    const flash = sc.hud.hit > 0 && flashOn(sc.t, 10);
    for (let i = 0; i < HITS_PER_LIFE; i++) {
      ctx.beginPath();
      ctx.arc(line.pips + HUD_PIP_RADIUS + i * HUD_PIP_STEP, 0, HUD_PIP_RADIUS, 0, TAU);
      ctx.fillStyle = i < me.hl ? PIP_FULL : flash ? LOST_FILL : PIP_EMPTY;
      ctx.fill();
    }
    // The wave and the players.
    ctx.font = LINE_FONT;
    ctx.fillStyle = LINE_DIM;
    const wt = line.short ? waveShort : waveLong;
    ctx.strokeText(wt, line.wave, 0);
    ctx.fillText(wt, line.wave, 0);
    if (line.short) {
      drawGlyph(line.players + HUD_GLYPH_WIDTH / 2, 0);
      const px = line.players + HUD_GLYPH_WIDTH + HUD_GLYPH_GAP;
      ctx.strokeText(playersShort, px, 0);
      ctx.fillText(playersShort, px, 0);
    } else {
      ctx.strokeText(playersLong, line.players, 0);
      ctx.fillText(playersLong, line.players, 0);
    }
    ctx.restore();
    const icons = iconCount(me);
    if (icons > 0) drawIcons(me, y + HUD_ICONS_BELOW);
    drawQueenHud(sc, y, icons);
    // "streak lost", flicking up and out under the score.
    if (sc.hud.lost > 0) {
      const f = sc.hud.lost / STREAK_LOST_S;
      ctx.globalAlpha = f;
      ctx.font = LOST_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 4;
      ctx.fillStyle = LOST_FILL;
      const ly = y + LOST_BELOW + hudIconsShift(icons) + barShift(sc) - (1 - f) * 8;
      ctx.strokeText("streak lost", hud.left, ly);
      ctx.fillText("streak lost", hud.left, ly);
      ctx.globalAlpha = 1;
    }
    // Down: DOWN and the seconds left under your robot, and how to get up.
    const you = sc.self >= 0 ? sc.robots[sc.self] : undefined;
    if (me.dn === 1 && you?.down) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 5;
      ctx.font = DOWN_FONT;
      ctx.fillStyle = HELP_FILL;
      const label = downText(Math.ceil(you.left));
      const dy = cssH / 2 + DOWN_BELOW;
      ctx.strokeText(label, hud.center, dy);
      ctx.fillText(label, hud.center, dy);
      ctx.lineWidth = 4;
      ctx.font = DOWN_HINT_FONT;
      ctx.fillStyle = TEXT_FILL;
      ctx.strokeText(DOWN_HINT, hud.center, dy + 34);
      ctx.fillText(DOWN_HINT, hud.center, dy + 34);
    }
  }

  /** One frame. */
  function draw(cam: Camera, sc: Scene): void {
    if (!teams || !floor) return;
    const { robots, count, self, t } = sc;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = LETTERBOX;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // The world, in world units, the camera's centre (shaken) at the screen's centre.
    const k = dpr * cam.scale;
    const left = cam.x - cam.w / 2 - sc.shake.offsetX;
    const top = cam.y - cam.h / 2 - sc.shake.offsetY;
    const ox = Math.round(-left * k);
    const oy = Math.round(-top * k);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    const x0 = Math.max(0, left);
    const y0 = Math.max(0, top);
    const x1 = Math.min(WORLD_W, left + cam.w);
    const y1 = Math.min(WORLD_H, top + cam.h);
    if (x1 > x0 && y1 > y0) {
      ctx.fillStyle = floor;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    ctx.strokeStyle = WALL_GLOW;
    ctx.lineWidth = WALL_GLOW_WIDTH;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);
    ctx.strokeStyle = WALL;
    ctx.lineWidth = WALL_WIDTH;
    ctx.strokeRect(0, 0, WORLD_W, WORLD_H);

    const margin = PLAYER_RADIUS * 6;
    vl = left - margin;
    vt = top - margin;
    vr = left + cam.w + margin;
    vb = top + cam.h + margin;
    // The screen inside the safe area, world units (cam.scale is CSS px per unit).
    sl = left + safe.left / cam.scale;
    st = top + safe.top / cam.scale;
    sr = left + cam.w - safe.right / cam.scale;
    sb = top + cam.h - safe.bottom / cam.scale;

    drawFloor(sc.floor, t);
    drawMarker(sc.queen, t);
    drawBugs(sc.bugs, t, k, ox, oy);
    drawShots(sc, k, ox, oy);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    drawParticles(sc.particles);
    drawTingRings(sc.tings);
    drawRings(sc.rings);

    // Revive rings under the robots, then the robots in view, yours last.
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
      if (r.down && inView(r.x, r.y)) drawRevive(r, robots, count);
    }
    for (let i = 0; i < count; i++) {
      if (i === self || !inView(robots[i]!.x, robots[i]!.y)) continue;
      drawRobot(robots[i]!, t);
      drawEffects(robots[i]!, t, sc.othersAt);
    }
    const me = self >= 0 ? robots[self] : undefined;
    if (me) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = ROBOT_HALO_ALPHA;
      ctx.drawImage(teams[me.team].glow, me.x - ROBOT_HALO_RADIUS, me.y - ROBOT_HALO_RADIUS, ROBOT_HALO_RADIUS * 2, ROBOT_HALO_RADIUS * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      drawRobot(me, t);
      drawEffects(me, t, sc.mineAt);
      if (!me.down) {
        const mh = PLAYER_RADIUS * ROBOT_MARK_HALF;
        ctx.drawImage(mark!, me.x - mh, me.y - mh, mh * 2, mh * 2);
        if (sc.me) drawHeat(me, sc.me, t);
        drawDashRing(me, sc.dashReady);
      }
    }
    // Name tags over every robot, as canvas text (never HTML: names are typed by viewers), and
    // never under the HUD band (#90): a tag that would reach it flips under its robot.
    const band = sc.out || !sc.me ? -Infinity : (hudBandBottom(iconCount(sc.me)) * dpr - oy) / k;
    ctx.font = NAME_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = TEXT_STROKE;
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
      if (!inView(r.x, r.y)) continue;
      ctx.fillStyle = i === self ? NAME_FILL : TEAM_LOOK[r.team].color;
      drawName(r, tagBaselines(r.y, band, r.down, spot).name);
    }
    // HELP over every downed robot in view, yours too, pulsing.
    ctx.font = HELP_FONT;
    ctx.fillStyle = HELP_FILL;
    const pulse = 1 + 0.18 * Math.sin(t * 7);
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
      if (!r.down || !inView(r.x, r.y)) continue;
      ctx.save();
      ctx.translate(r.x, tagBaselines(r.y, band, true, spot).help);
      ctx.scale(pulse, pulse);
      ctx.strokeText(HELP_TEXT, 0, 0);
      ctx.fillText(HELP_TEXT, 0, 0);
      ctx.restore();
    }

    // Screen space: the vignette, the hit flash, floating scores, the HUD, the sticks, the minimap.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (vignette) ctx.drawImage(vignette, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sc.hud.hit > 0 && !sc.watch) {
      ctx.globalAlpha = 0.28 * (sc.hud.hit / HIT_FLASH_S);
      ctx.strokeStyle = HIT_EDGE;
      ctx.lineWidth = 24;
      ctx.strokeRect(0, 0, cssW, cssH);
      ctx.globalAlpha = 1;
    }
    const texts = sc.texts;
    if (texts.live > 0) {
      ctx.font = TEXT_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = TEXT_STROKE;
      ctx.fillStyle = TEXT_FILL;
      for (let i = 0; i < texts.life.length; i++) {
        const life = texts.life[i]!;
        if (life <= 0) continue;
        ctx.globalAlpha = Math.min(1, (2 * life) / TEXT_SECONDS);
        const x = (texts.x[i]! - left) * cam.scale;
        const y = (texts.y[i]! - top) * cam.scale;
        const label = textLabel(texts, i);
        ctx.strokeText(label, x, y);
        ctx.fillText(label, x, y);
      }
      ctx.globalAlpha = 1;
    }
    const tg = sc.tings;
    if (tg.live > 0) {
      // The "ting" over each blocked shot (#80): small and pale blue, under the score labels' size.
      ctx.font = TING_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.strokeStyle = TEXT_STROKE;
      ctx.fillStyle = TING_FILL;
      for (let i = 0; i < tg.age.length; i++) {
        if (tg.age[i]! >= TING_S) continue;
        tingLook(tg.age[i]!, ting);
        ctx.globalAlpha = ting.wordAlpha;
        const x = (tg.x[i]! - left) * cam.scale;
        const y = (tg.y[i]! - TING_ABOVE - ting.rise - top) * cam.scale;
        ctx.strokeText(TING_WORD, x, y);
        ctx.fillText(TING_WORD, x, y);
      }
      ctx.globalAlpha = 1;
    }
    if (sc.watch) return;
    if (sc.dashButton && !sc.out) drawDashButton(sc.dashButton, sc.dashReady);
    for (const s of sc.sticks) drawStick(s);

    // An arrow at the edge to each downed player out of view within reach of you.
    if (me) {
      for (let i = 0; i < count; i++) {
        const r = robots[i]!;
        if (i === self || !r.down) continue;
        if (!edgeArrow(cam, cssW, cssH, safe, me.x, me.y, r.x, r.y, arrow)) continue;
        ctx.save();
        ctx.translate(arrow.x, arrow.y);
        ctx.rotate(arrow.angle);
        ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 7);
        ctx.fillStyle = HELP_FILL;
        ctx.strokeStyle = TEXT_STROKE;
        ctx.lineWidth = 3;
        ctx.lineJoin = "round";
        ctx.beginPath();
        ctx.moveTo(ARROW_LENGTH / 2, 0);
        ctx.lineTo(-ARROW_LENGTH / 2, -ARROW_WIDTH / 2);
        ctx.lineTo(-ARROW_LENGTH / 2, ARROW_WIDTH / 2);
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        ctx.restore();
      }
    }

    drawQueenArrow(cam, sc.queen, t);

    const m = minimap;
    ctx.fillStyle = MINIMAP_FILL;
    ctx.fillRect(m.x, m.y, m.size, m.size);
    ctx.strokeStyle = MINIMAP_VIEW;
    ctx.lineWidth = 1;
    const vx = Math.max(0, left);
    const vy = Math.max(0, top);
    ctx.strokeRect(m.x + (vx / WORLD_W) * m.size, m.y + (vy / WORLD_H) * m.size, ((Math.min(WORLD_W, left + cam.w) - vx) / WORLD_W) * m.size, ((Math.min(WORLD_H, top + cam.h) - vy) / WORLD_H) * m.size);
    ctx.strokeStyle = MINIMAP_EDGE;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(m.x, m.y, m.size, m.size);
    ctx.fillStyle = MINIMAP_BUG;
    const bugs = sc.bugs;
    for (let i = 0; i < bugs.count; i++) {
      // A glob is a shot in flight, not a bug in the swarm: no dot.
      if (bugs.kind[i] === GLOB_KIND) continue;
      toMinimap(m, bugs.x[i]!, bugs.y[i]!, dot);
      ctx.fillRect(dot.x - 1, dot.y - 1, 2, 2);
    }
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
      if (!minimapDotOn(r.down, t)) continue;
      toMinimap(m, r.x, r.y, dot);
      ctx.fillStyle = TEAM_LOOK[r.team].color;
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, i === self ? MINIMAP_DOT + 0.5 : MINIMAP_DOT, 0, TAU);
      ctx.fill();
      if (i === self) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    // The hive queen (#85): a pulsing mark where she is, a ring where she is about to arrive.
    const q = sc.queen;
    if (q.length > 0) {
      const alive = q[0] === 1;
      if (q[0] === 1) toMinimap(m, q[2], q[3], dot);
      else if (q[0] === 0) toMinimap(m, q[1], q[2], dot);
      // Pulses up from QUEEN_MAP_DOT, never down: at its smallest twice a player dot's size.
      const r = QUEEN_MAP_DOT * (1 + 0.2 * (0.5 + 0.5 * Math.sin(t * TAU * 1.5)));
      ctx.beginPath();
      ctx.arc(dot.x, dot.y, r, 0, TAU);
      ctx.lineWidth = 2;
      if (alive) {
        // Alive: an amber centre in a white ring in an amber ring, a shape no player or bug dot has.
        ctx.fillStyle = QUEEN_COLOUR;
        ctx.fill();
        ctx.strokeStyle = QUEEN_MAP_RING;
        ctx.stroke();
        // And a second, amber ring outside it, so she never reads as your own white-ringed dot.
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r + 3, 0, TAU);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = QUEEN_COLOUR;
      } else ctx.strokeStyle = QUEEN_COLOUR;
      ctx.stroke();
    }

    if (!sc.out) drawHud(sc);
    // The F readout, under the line (off by default; F toggles it).
    if (sc.stats) {
      ctx.font = STATS_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(sc.stats, hud.left, hud.top + LINE_MIDDLE + STATS_BELOW + (sc.out ? 0 : hudIconsShift(iconCount(sc.me)) + barShift(sc)));
    }
  }

  return { resize, draw, size: () => ({ w: cssW, h: cssH }) };
}
