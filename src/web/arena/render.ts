// Draws an arena frame: the floor grid, the walls, every robot with its trail, barrel and name
// tag, your own ring, the sticks, the minimap and the F readout. It reuses release 1's sprites
// (src/web/game/sprites.ts) so the arena looks like the same game: the robot sprite in each
// team's colour, the glow, the marker ring and one tile of the floor grid, repeated. Sprites are
// built on resize only; a frame allocates nothing but the strings of a name that changed.
import { PLAYER_RADIUS, WORLD_H, WORLD_W } from "../../shared/arena/constants";
import type { Team } from "../../server/rules";
import { TRAIL_SECONDS, trailSlot, type Trail } from "../game/fx/trail";
import type { Insets } from "../game/hud";
import { hudLayout } from "../game/hud";
import {
  GLOW_WHITE,
  LETTERBOX,
  PALETTE,
  ROBOT_HALO_ALPHA,
  ROBOT_HALO_RADIUS,
  STICK_KNOB,
  STICK_KNOB_RADIUS,
  STICK_RING,
  STICK_RING_WIDTH,
  TEXT_STROKE,
  VIGNETTE,
} from "../game/look";
import { ROBOT_MARK_HALF, ROBOT_SPRITE_HALF, buildGlow, buildRobot, floorTile, robotMarkSprite } from "../game/sprites";
import { STICK_RANGE, stickKnob, type Stick } from "../game/stick";
import { TEAM_LOOK } from "../teams";
import type { Camera } from "./camera";
import { minimapLayout, toMinimap, type MinimapLayout } from "./minimap";

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
const STATS_FONT = "bold 16px system-ui, sans-serif";

/** One robot to draw, world units. */
export type Robot = { id: number; x: number; y: number; aim: number; team: Team; name: string; trail: Trail };

type TeamSprites = { body: HTMLCanvasElement; glow: HTMLCanvasElement };

export function createArenaRenderer(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  let dpr = 1;
  let cssW = 1;
  let cssH = 1;
  let ppu = 0;
  let teams: Record<Team, TeamSprites> | null = null;
  let white: HTMLCanvasElement | null = null;
  let mark: HTMLCanvasElement | null = null;
  let floor: CanvasPattern | null = null;
  let vignette: HTMLCanvasElement | null = null;
  let minimap: MinimapLayout = minimapLayout(1, 1, { top: 0, right: 0, bottom: 0, left: 0 });
  let statsLeft = 16;
  let statsTop = 16;
  const knob = { x: 0, y: 0 };
  const dot = { x: 0, y: 0 };
  // The view plus a margin for halos and names, world units: set at the start of each frame.
  let vl = 0;
  let vt = 0;
  let vr = 0;
  let vb = 0;
  const visible = (r: Robot) => r.x > vl && r.x < vr && r.y > vt && r.y < vb;

  /** The canvas is `w` x `h` CSS px at `newDpr`; the camera's scale is CSS px per unit. */
  function resize(w: number, h: number, newDpr: number, cam: Camera, insets: Insets): void {
    cssW = w;
    cssH = h;
    dpr = newDpr;
    minimap = minimapLayout(w, h, insets);
    const hud = hudLayout(w, insets);
    statsLeft = hud.left;
    statsTop = hud.top;
    const k = dpr * cam.scale;
    if (teams && Math.abs(k - ppu) < 0.01) return;
    ppu = k;
    teams = {
      tabs: { body: buildRobot(ppu, TEAM_LOOK.tabs.color), glow: buildGlow(TEAM_LOOK.tabs.color) },
      spaces: { body: buildRobot(ppu, TEAM_LOOK.spaces.color), glow: buildGlow(TEAM_LOOK.spaces.color) },
    };
    white = buildGlow(PALETTE[GLOW_WHITE]);
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

  /**
   * One frame. `robots[0..count)` are drawn, `self` (an index, or -1) last and ringed. `t` is
   * seconds, for the core's pulse. `stats` is the F readout's text, or null when it is off.
   */
  function draw(cam: Camera, robots: readonly Robot[], count: number, self: number, t: number, sticks: readonly Stick[], stats: string | null): void {
    if (!teams || !floor) return;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = LETTERBOX;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // The world, in world units, the camera's centre at the screen's centre.
    const k = dpr * cam.scale;
    const left = cam.x - cam.w / 2;
    const top = cam.y - cam.h / 2;
    ctx.setTransform(k, 0, 0, k, Math.round(-left * k), Math.round(-top * k));
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

    // Robots in view (plus a margin for halos and names), yours last.
    const margin = PLAYER_RADIUS * 6;
    vl = left - margin;
    vt = top - margin;
    vr = left + cam.w + margin;
    vb = top + cam.h + margin;
    for (let i = 0; i < count; i++) if (i !== self && visible(robots[i]!)) drawRobot(robots[i]!, t);
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
      if (!visible(r)) continue;
      ctx.fillStyle = i === self ? NAME_FILL : TEAM_LOOK[r.team].color;
      drawName(r);
    }

    // Screen space: the vignette, the sticks, the minimap, the readout.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (vignette) ctx.drawImage(vignette, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of sticks) drawStick(s);

    const m = minimap;
    ctx.fillStyle = MINIMAP_FILL;
    ctx.fillRect(m.x, m.y, m.size, m.size);
    ctx.strokeStyle = MINIMAP_VIEW;
    ctx.lineWidth = 1;
    const vx = Math.max(0, left);
    const vy = Math.max(0, top);
    ctx.strokeRect(m.x + (vx / WORLD_W) * m.size, m.y + (vy / WORLD_H) * m.size, (Math.min(WORLD_W, left + cam.w) - vx) / WORLD_W * m.size, (Math.min(WORLD_H, top + cam.h) - vy) / WORLD_H * m.size);
    ctx.strokeStyle = MINIMAP_EDGE;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(m.x, m.y, m.size, m.size);
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

    if (stats) {
      ctx.font = STATS_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(stats, statsLeft, statsTop);
    }
  }

  return { resize, draw, size: () => ({ w: cssW, h: cssH }) };
}
