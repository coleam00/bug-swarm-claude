// Draws an arena frame: the floor grid, the walls, the bugs, every shot as a glowing streak, the
// sparks, kill bursts and floating scores, every robot with its trail, dash afterimage, barrel and
// name tag, your own ring, heat arc and dash cooldown ring, the dash button, the HUD (score, multiplier, "streak lost", wave, hits left), the life-over
// overlay, the sticks, the minimap and the F readout. It reuses release 1's sprites and pooled
// effects (src/web/game/sprites.ts and fx/) so the arena looks like the same game. Sprites are
// built on resize only; a frame allocates nothing but the strings of a value that changed.
import { HITS_PER_LIFE, PLAYER_RADIUS, WORLD_H, WORLD_W, type BugKind } from "../../shared/arena/constants";
import type { SnapshotMe } from "../../shared/arena/protocol";
import type { Team } from "../../server/rules";
import type { Particles } from "../game/fx/particles";
import type { Shake } from "../game/fx/shake";
import { TEXT_SECONDS, textLabel, type Texts } from "../game/fx/text";
import { TRAIL_SECONDS, trailSlot, type Trail } from "../game/fx/trail";
import type { Insets } from "../game/hud";
import { hudLayout } from "../game/hud";
import {
  BUG_LOOKS,
  GLOW_SHOT,
  GLOW_WHITE,
  LETTERBOX,
  PALETTE,
  ROBOT_HALO_ALPHA,
  ROBOT_HALO_RADIUS,
  SHOT_CORE,
  STICK_KNOB,
  STICK_KNOB_RADIUS,
  STICK_RING,
  STICK_RING_WIDTH,
  TEXT_FILL,
  TEXT_FONT,
  TEXT_STROKE,
  VIGNETTE,
  type BugLookId,
} from "../game/look";
import { BUG_SPRITE_HALF, ROBOT_MARK_HALF, ROBOT_SPRITE_HALF, buildBugSprites, buildGlow, buildRobot, floorTile, robotMarkSprite } from "../game/sprites";
import { STICK_RANGE, stickKnob, type Stick } from "../game/stick";
import { TEAM_LOOK } from "../teams";
import type { Camera } from "./camera";
import type { DashButton } from "./controls";
import { HIT_FLASH_S, STREAK_LOST_S, flashOn, heatWarning, pulseScale, type HudFx } from "./hudfx";
import { minimapLayout, toMinimap, type MinimapLayout } from "./minimap";
import { shotTravel, type ClientShots } from "./shots";

/** The floor tile's side, world units (a multiple of the grid spacing). */
const TILE = 240;
const TAU = Math.PI * 2;
/** The barrel: a rounded bar from the robot's edge along the aim, world units. */
const BARREL_LENGTH = 10;
const BARREL_WIDTH = 5;
const BARREL_COLOUR = "#e2e8f0";
const NAME_FONT = "bold 13px system-ui, sans-serif";
const NAME_FILL = "#f8fafc";
/** The name tag's baseline above the robot's centre, world units. */
const NAME_ABOVE = PLAYER_RADIUS * 1.9;
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
/** Leg frames walked forward then back: 0 1 2 3 2 1 (release 1's). */
const LEG_CYCLE = [0, 1, 2, 3, 2, 1];
const PARTICLE_SIZE = 7;
/** A shot: a glow this long behind its head with a bright core, world units (release 1's look). */
const SHOT_GLOW_LENGTH = 28;
const SHOT_GLOW_WIDTH = 14;
const SHOT_CORE_LENGTH = 18;
const SHOT_CORE_WIDTH = 2.4;
/** How each bug kind looks, from release 1's looks. */
const BUG_LOOK: Record<BugKind, BugLookId> = { crawler: "base" };
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
// The HUD.
const SCORE_FONT = "bold 30px system-ui, sans-serif";
const MULT_FONT = "bold 22px system-ui, sans-serif";
const LOST_FONT = "bold 16px system-ui, sans-serif";
const WAVE_FONT = "bold 20px system-ui, sans-serif";
const MULT_ON = "#fde047";
const MULT_OFF = "#94a3b8";
const LOST_FILL = "#f87171";
const PIP_RADIUS = 6;
const PIP_GAP = 18;
const PIP_FULL = "#f8fafc";
const PIP_EMPTY = "rgba(248, 250, 252, 0.25)";
const HIT_EDGE = "rgba(248, 113, 113, 1)";
const OVER_SHADE = "rgba(5, 7, 13, 0.6)";
const OVER_TITLE_FONT = "bold 44px system-ui, sans-serif";
const OVER_SCORE_FONT = "bold 30px system-ui, sans-serif";
const OVER_LINE_FONT = "bold 20px system-ui, sans-serif";

/**
 * One robot to draw, world units. `inv`: untouchable, so it blinks. `dashing`: in a dash now.
 * `dashAt`: when its last dash began, scene seconds (-1: never), from `dashFromX, dashFromY`.
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
  dashing: boolean;
  dashAt: number;
  dashFromX: number;
  dashFromY: number;
};

/** The bugs to draw this frame, world units, in typed arrays filled by main.ts. */
export type BugsView = { x: Float32Array; y: Float32Array; heading: Float32Array; phase: Float32Array; kind: Uint8Array; count: number };

/** The life-over overlay's text, built once when the life ends. */
export type OverView = { title: string; score: string; line: string; prompt: string; ready: boolean };

/** Everything a frame draws besides the camera. */
export type Scene = {
  robots: readonly Robot[];
  count: number;
  /** Your robot's index in `robots`, or -1 (out, or not yet in). */
  self: number;
  /** Seconds, for pulses and leg frames. */
  t: number;
  bugs: BugsView;
  shots: ClientShots;
  /** The ticks shots are drawn at: yours, and everyone else's. */
  mineAt: number;
  othersAt: number;
  you: number | null;
  particles: Particles;
  texts: Texts;
  shake: Shake;
  /** Your numbers, or null before the first snapshot. */
  me: SnapshotMe | null;
  wave: number;
  hud: HudFx;
  over: OverView | null;
  sticks: readonly Stick[];
  stats: string | null;
  /** The dash button, CSS px, while you are in a life; else null. */
  dashButton: DashButton | null;
  /** How far your dash has cooled, 0 to 1 (1: ready). */
  dashReady: number;
};

type TeamSprites = { body: HTMLCanvasElement; glow: HTMLCanvasElement };

const scoreFormat = new Intl.NumberFormat("en-US");

export function createArenaRenderer(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  let dpr = 1;
  let cssW = 1;
  let cssH = 1;
  let ppu = 0;
  let teams: Record<Team, TeamSprites> | null = null;
  let white: HTMLCanvasElement | null = null;
  let glows: HTMLCanvasElement[] = [];
  let bugSprites: Record<BugLookId, HTMLCanvasElement[]> | null = null;
  let mark: HTMLCanvasElement | null = null;
  let floor: CanvasPattern | null = null;
  let vignette: HTMLCanvasElement | null = null;
  let minimap: MinimapLayout = minimapLayout(1, 1, { top: 0, right: 0, bottom: 0, left: 0 });
  let hud = hudLayout(1, { top: 0, right: 0, bottom: 0, left: 0 });
  const knob = { x: 0, y: 0 };
  const dot = { x: 0, y: 0 };
  // HUD strings, rebuilt only when their value changes.
  let scoreShown = -1;
  let scoreText = "";
  const multTexts = new Map<number, string>();
  const waveTexts = new Map<number, string>();
  // The view plus a margin for halos and names, world units: set at the start of each frame.
  let vl = 0;
  let vt = 0;
  let vr = 0;
  let vb = 0;
  const inView = (x: number, y: number) => x > vl && x < vr && y > vt && y < vb;

  const multText = (m: number) => {
    let s = multTexts.get(m);
    if (s === undefined) multTexts.set(m, (s = `x${m}`));
    return s;
  };
  const waveText = (w: number) => {
    let s = waveTexts.get(w);
    if (s === undefined) waveTexts.set(w, (s = `Wave ${w}`));
    return s;
  };

  /** The canvas is `w` x `h` CSS px at `newDpr`; the camera's scale is CSS px per unit. */
  function resize(w: number, h: number, newDpr: number, cam: Camera, insets: Insets): void {
    cssW = w;
    cssH = h;
    dpr = newDpr;
    minimap = minimapLayout(w, h, insets);
    hud = hudLayout(w, insets);
    const k = dpr * cam.scale;
    if (teams && Math.abs(k - ppu) < 0.01) return;
    ppu = k;
    teams = {
      tabs: { body: buildRobot(ppu, TEAM_LOOK.tabs.color), glow: buildGlow(TEAM_LOOK.tabs.color) },
      spaces: { body: buildRobot(ppu, TEAM_LOOK.spaces.color), glow: buildGlow(TEAM_LOOK.spaces.color) },
    };
    glows = PALETTE.map((c) => buildGlow(c));
    white = glows[GLOW_WHITE]!;
    bugSprites = buildBugSprites(ppu);
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

  function drawRobot(r: Robot, t: number): void {
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

  function drawName(r: Robot): void {
    ctx.strokeText(r.name, r.x, r.y - NAME_ABOVE);
    ctx.fillText(r.name, r.x, r.y - NAME_ABOVE);
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

  function drawBugs(b: BugsView, t: number, k: number, ox: number, oy: number): void {
    for (let i = 0; i < b.count; i++) {
      const x = b.x[i]!;
      const y = b.y[i]!;
      if (!inView(x, y)) continue;
      const id = BUG_LOOK.crawler;
      const look = BUG_LOOKS[id];
      const phase = b.phase[i]!;
      const a = b.heading[i]! + look.jitter * Math.sin(TAU * (t * look.jitterHz + phase));
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const u = t * look.legHz + phase;
      const frame = LEG_CYCLE[Math.floor((u - Math.floor(u)) * LEG_CYCLE.length)]!;
      const half = look.radius * BUG_SPRITE_HALF;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * x + ox, k * y + oy);
      ctx.drawImage(bugSprites![id][frame]!, -half, -half, half * 2, half * 2);
    }
  }

  function drawShots(sc: Scene, k: number, ox: number, oy: number): void {
    const s = sc.shots;
    if (s.live === 0) return;
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = SHOT_CORE;
    const glow = glows[GLOW_SHOT]!;
    for (let i = 0; i < s.used.length; i++) {
      if (!s.used[i]) continue;
      const travel = shotTravel(s, i, s.owner[i] === sc.you ? sc.mineAt : sc.othersAt);
      if (travel < 0) continue;
      const dx = s.dx[i]!;
      const dy = s.dy[i]!;
      const x = s.x0[i]! + dx * travel;
      const y = s.y0[i]! + dy * travel;
      if (!inView(x, y)) continue;
      // The streak never reaches back behind the barrel.
      const tail = Math.min(SHOT_GLOW_LENGTH, travel + 6);
      const core = Math.min(SHOT_CORE_LENGTH, travel + 2);
      ctx.setTransform(k * dx, k * dy, -k * dy, k * dx, k * x + ox, k * y + oy);
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

  function drawHud(sc: Scene): void {
    const me = sc.me;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.strokeStyle = TEXT_STROKE;
    ctx.lineWidth = 4;
    if (me) {
      if (me.sc !== scoreShown) {
        scoreShown = me.sc;
        scoreText = scoreFormat.format(me.sc);
      }
      ctx.font = SCORE_FONT;
      ctx.fillStyle = TEXT_FILL;
      ctx.strokeText(scoreText, hud.left, hud.top);
      ctx.fillText(scoreText, hud.left, hud.top);
      // The multiplier, pulsing when it goes up.
      const my = hud.top + 38;
      const scale = pulseScale(sc.hud);
      ctx.save();
      ctx.translate(hud.left, my + 11);
      ctx.scale(scale, scale);
      ctx.font = MULT_FONT;
      ctx.textBaseline = "middle";
      ctx.fillStyle = me.mu > 1 ? MULT_ON : MULT_OFF;
      const mt = multText(me.mu);
      ctx.strokeText(mt, 0, 0);
      ctx.fillText(mt, 0, 0);
      ctx.restore();
      // "streak lost", flicking up and out.
      if (sc.hud.lost > 0) {
        const f = sc.hud.lost / STREAK_LOST_S;
        ctx.globalAlpha = f;
        ctx.font = LOST_FONT;
        ctx.textBaseline = "middle";
        ctx.fillStyle = LOST_FILL;
        const y = my + 11 - (1 - f) * 10;
        ctx.strokeText("streak lost", hud.left + 58, y);
        ctx.fillText("streak lost", hud.left + 58, y);
        ctx.globalAlpha = 1;
      }
      // Hits left, flashing as one goes.
      const py = my + 40;
      const flash = sc.hud.hit > 0 && flashOn(sc.t, 10);
      for (let i = 0; i < HITS_PER_LIFE; i++) {
        ctx.beginPath();
        ctx.arc(hud.left + PIP_RADIUS + i * PIP_GAP, py, PIP_RADIUS, 0, TAU);
        ctx.fillStyle = i < me.hl ? PIP_FULL : flash ? LOST_FILL : PIP_EMPTY;
        ctx.fill();
      }
    }
    if (sc.wave > 0) {
      ctx.font = WAVE_FONT;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = TEXT_FILL;
      const wt = waveText(sc.wave);
      ctx.strokeText(wt, hud.center, hud.top + 4);
      ctx.fillText(wt, hud.center, hud.top + 4);
    }
  }

  function drawOver(o: OverView, t: number): void {
    ctx.fillStyle = OVER_SHADE;
    ctx.fillRect(0, 0, cssW, cssH);
    const cx = cssW / 2;
    const cy = cssH / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.strokeStyle = TEXT_STROKE;
    ctx.lineWidth = 5;
    ctx.fillStyle = TEXT_FILL;
    ctx.font = OVER_TITLE_FONT;
    ctx.strokeText(o.title, cx, cy - 70);
    ctx.fillText(o.title, cx, cy - 70);
    ctx.font = OVER_SCORE_FONT;
    ctx.fillStyle = MULT_ON;
    ctx.strokeText(o.score, cx, cy - 18);
    ctx.fillText(o.score, cx, cy - 18);
    ctx.font = OVER_LINE_FONT;
    ctx.fillStyle = TEXT_FILL;
    ctx.strokeText(o.line, cx, cy + 22);
    ctx.fillText(o.line, cx, cy + 22);
    if (o.ready) {
      ctx.globalAlpha = 0.65 + 0.35 * Math.sin(t * 4);
      ctx.strokeText(o.prompt, cx, cy + 78);
      ctx.fillText(o.prompt, cx, cy + 78);
      ctx.globalAlpha = 1;
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

    drawBugs(sc.bugs, t, k, ox, oy);
    drawShots(sc, k, ox, oy);
    ctx.setTransform(k, 0, 0, k, ox, oy);
    drawParticles(sc.particles);

    // Robots in view, yours last.
    for (let i = 0; i < count; i++) if (i !== self && inView(robots[i]!.x, robots[i]!.y)) drawRobot(robots[i]!, t);
    const me = self >= 0 ? robots[self] : undefined;
    if (me) {
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = ROBOT_HALO_ALPHA;
      ctx.drawImage(teams[me.team].glow, me.x - ROBOT_HALO_RADIUS, me.y - ROBOT_HALO_RADIUS, ROBOT_HALO_RADIUS * 2, ROBOT_HALO_RADIUS * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      drawRobot(me, t);
      const mh = PLAYER_RADIUS * ROBOT_MARK_HALF;
      ctx.drawImage(mark!, me.x - mh, me.y - mh, mh * 2, mh * 2);
      if (sc.me) drawHeat(me, sc.me, t);
      drawDashRing(me, sc.dashReady);
    }
    // Name tags over every robot, as canvas text (never HTML: names are typed by viewers).
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
      drawName(r);
    }

    // Screen space: the vignette, the hit flash, floating scores, the HUD, the sticks, the minimap.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (vignette) ctx.drawImage(vignette, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sc.hud.hit > 0) {
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
    if (sc.dashButton && !sc.over) drawDashButton(sc.dashButton, sc.dashReady);
    for (const s of sc.sticks) drawStick(s);

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
      toMinimap(m, bugs.x[i]!, bugs.y[i]!, dot);
      ctx.fillRect(dot.x - 1, dot.y - 1, 2, 2);
    }
    for (let i = 0; i < count; i++) {
      const r = robots[i]!;
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

    if (sc.over) drawOver(sc.over, t);
    else drawHud(sc);
    // The F readout shows over everything, the life-over screen too.
    if (sc.stats) {
      ctx.font = STATS_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(sc.stats, hud.left, hud.top + 100);
    }
  }

  return { resize, draw, size: () => ({ w: cssW, h: cssH }) };
}
