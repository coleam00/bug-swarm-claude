// Draws the backdrop: a drifting grid floor, robot trails, bugs, shots, pop particles and the
// robots in their team colours, under a vignette. Release 1's sprites and effects, drawn the way
// render.ts draws them (sprites and additive glows, never shadowBlur). Reads the simulation,
// changes nothing; builds no strings, arrays or closures per frame.
import { TEAMS } from "../../server/rules";
import { ROBOT_RADIUS } from "../game/config";
import type { Particles } from "../game/fx/particles";
import { TRAIL_SECONDS, trailSlot, type Trail } from "../game/fx/trail";
import { BUG_LOOK_IDS, BUG_LOOKS, FLOOR, GLOW_WHITE, GRID_RGB, GRID_SPACING, LETTERBOX, PALETTE, SHOT_CORE, VIGNETTE, type BugLookId } from "../game/look";
import { BUG_SPRITE_HALF, ROBOT_SPRITE_HALF, buildBugSprites, buildGlow, buildRobot } from "../game/sprites";
import { TEAM_LOOK } from "../teams";
import { ROBOTS, SHOTS_MAX, BUGS_MAX, type Backdrop } from "./sim";

export type BackdropFx = { particles: Particles; trails: Trail[] };

const TAU = Math.PI * 2;
const LEG_CYCLE = [0, 1, 2, 3, 2, 1];
const PARTICLE_SIZE = 7;
const SHOT_GLOW_LENGTH = 34;
const SHOT_GLOW_WIDTH = 14;
const SHOT_CORE_LENGTH = 18;
const SHOT_CORE_WIDTH = 2.4;
const BARREL = ROBOT_RADIUS * 1.6;

type Built = {
  ppu: number;
  bugs: Record<BugLookId, HTMLCanvasElement[]>;
  robots: HTMLCanvasElement[];
  teamGlows: HTMLCanvasElement[];
  /** PALETTE glows, for particles and the robots' white-hot core. */
  glows: HTMLCanvasElement[];
  floor: CanvasPattern | null;
  /** The floor tile's size in device pixels: the drift wraps at exactly this. */
  tilePx: number;
};

export function createBackdropDraw(ctx: CanvasRenderingContext2D) {
  const canvas = ctx.canvas;
  let ppu = 1;
  let built: Built | null = null;
  let vignette: HTMLCanvasElement | null = null;

  /** Sizes the canvas for a `cssW` x `cssH` screen at `dpr`, showing `world` edge to edge. */
  function resize(cssW: number, cssH: number, dpr: number, world: { w: number; h: number }): void {
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));
    ppu = canvas.width / world.w;
    if (!built || Math.abs(built.ppu - ppu) > 0.01) built = build(ppu);
    vignette = vignetteSprite(Math.max(1, Math.round(cssW)), Math.max(1, Math.round(cssH)));
  }

  function build(k: number): Built {
    const tilePx = Math.max(4, Math.round(GRID_SPACING * k));
    const tile = document.createElement("canvas");
    tile.width = tile.height = tilePx;
    const t = tile.getContext("2d");
    let floor: CanvasPattern | null = null;
    if (t) {
      t.fillStyle = FLOOR;
      t.fillRect(0, 0, tilePx, tilePx);
      // One vertical and one horizontal line through the middle of the tile, so neither is cut at its edge.
      const mid = tilePx / 2;
      const s = tilePx / GRID_SPACING;
      for (const [width, alpha] of [
        [5, 0.035],
        [2.5, 0.05],
        [1, 0.13],
      ] as const) {
        t.lineWidth = width * s;
        t.strokeStyle = `rgba(${GRID_RGB}, ${alpha})`;
        t.beginPath();
        t.moveTo(mid, 0);
        t.lineTo(mid, tilePx);
        t.moveTo(0, mid);
        t.lineTo(tilePx, mid);
        t.stroke();
      }
      floor = ctx.createPattern(tile, "repeat");
    }
    return {
      ppu: k,
      bugs: buildBugSprites(k),
      robots: TEAMS.map((team) => buildRobot(k, TEAM_LOOK[team].color)),
      teamGlows: TEAMS.map((team) => buildGlow(TEAM_LOOK[team].color)),
      glows: PALETTE.map(buildGlow),
      floor,
      tilePx,
    };
  }

  function draw(b: Backdrop, fx: BackdropFx): void {
    const s = built;
    if (!s) return;
    const k = ppu;
    const t = b.time;
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    // The floor, drifting diagonally; the pattern repeats every tile, so it wraps without a seam.
    const shift = b.drift * s.tilePx;
    ctx.setTransform(1, 0, 0, 1, shift, shift);
    ctx.fillStyle = s.floor ?? LETTERBOX;
    ctx.fillRect(-shift, -shift, canvas.width, canvas.height);

    // Robot trails, in their team's glow.
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    for (let r = 0; r < ROBOTS; r++) {
      const trail = fx.trails[r]!;
      const glow = s.teamGlows[b.robotTeam[r]!]!;
      for (let n = 1; n < trail.count; n++) {
        const i = trailSlot(trail, n);
        const life = 1 - trail.age[i]! / TRAIL_SECONDS;
        if (life <= 0) continue;
        const size = ROBOT_RADIUS * (0.6 + 0.9 * life);
        ctx.globalAlpha = 0.4 * life;
        ctx.drawImage(glow, trail.x[i]! - size, trail.y[i]! - size, size * 2, size * 2);
      }
    }
    ctx.globalAlpha = 1;

    // Bugs, each turned to its heading, legs walking.
    ctx.globalCompositeOperation = "source-over";
    for (let j = 0; j < BUGS_MAX; j++) {
      if (!b.bugAlive[j]) continue;
      const id = BUG_LOOK_IDS[b.bugLook[j]!]!;
      const look = BUG_LOOKS[id];
      const c = Math.cos(b.bugHeading[j]!);
      const sn = Math.sin(b.bugHeading[j]!);
      const u = t * look.legHz + b.bugPhase[j]!;
      const frame = LEG_CYCLE[Math.floor((u - Math.floor(u)) * LEG_CYCLE.length)]!;
      const half = look.radius * BUG_SPRITE_HALF;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * b.bugX[j]!, k * b.bugY[j]!);
      ctx.drawImage(s.bugs[id][frame]!, -half, -half, half * 2, half * 2);
    }

    // Shots: a team-coloured streak with a bright core.
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = SHOT_CORE;
    for (let i = 0; i < SHOTS_MAX; i++) {
      if (b.shotLife[i]! <= 0) continue;
      const vx = b.shotVx[i]!;
      const vy = b.shotVy[i]!;
      const v = Math.hypot(vx, vy) || 1;
      const c = vx / v;
      const sn = vy / v;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * b.shotX[i]!, k * b.shotY[i]!);
      ctx.drawImage(s.teamGlows[b.shotTeam[i]!]!, 6 - SHOT_GLOW_LENGTH, -SHOT_GLOW_WIDTH / 2, SHOT_GLOW_LENGTH, SHOT_GLOW_WIDTH);
      ctx.fillRect(2 - SHOT_CORE_LENGTH, -SHOT_CORE_WIDTH / 2, SHOT_CORE_LENGTH, SHOT_CORE_WIDTH);
    }

    // Pop particles.
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const p = fx.particles;
    if (p.live > 0) {
      for (let i = 0; i < p.life.length; i++) {
        const life = p.life[i]!;
        if (life <= 0) continue;
        const l = life / p.maxLife[i]!;
        const size = PARTICLE_SIZE * (0.4 + 0.6 * l);
        ctx.globalAlpha = l;
        ctx.drawImage(s.glows[p.colour[i]!]!, p.x[i]! - size, p.y[i]! - size, size * 2, size * 2);
      }
      ctx.globalAlpha = 1;
    }

    // Robots: a barrel toward the aim, the team-rimmed body, then a pulsing core.
    const rh = ROBOT_RADIUS * ROBOT_SPRITE_HALF;
    ctx.lineCap = "round";
    ctx.lineWidth = 5;
    for (let r = 0; r < ROBOTS; r++) {
      const x = b.robotX[r]!;
      const y = b.robotY[r]!;
      const team = b.robotTeam[r]!;
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = TEAM_LOOK[TEAMS[team]!].color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(b.robotAim[r]!) * BARREL, y + Math.sin(b.robotAim[r]!) * BARREL);
      ctx.stroke();
      ctx.drawImage(s.robots[team]!, x - rh, y - rh, rh * 2, rh * 2);
      ctx.globalCompositeOperation = "lighter";
      const core = ROBOT_RADIUS * (1.05 + 0.12 * Math.sin(t * 8 + r));
      ctx.drawImage(s.teamGlows[team]!, x - core, y - core, core * 2, core * 2);
      const hot = ROBOT_RADIUS * 0.45;
      ctx.drawImage(s.glows[GLOW_WHITE]!, x - hot, y - hot, hot * 2, hot * 2);
    }

    // The vignette, stretched over the whole screen.
    ctx.globalCompositeOperation = "source-over";
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (vignette) ctx.drawImage(vignette, 0, 0, canvas.width, canvas.height);
  }

  return { resize, draw };
}

/** A dark edge fading to clear in the middle, at CSS resolution (it is smooth, so it stretches well). */
function vignetteSprite(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
  g.addColorStop(0, "rgba(0, 0, 0, 0)");
  g.addColorStop(1, VIGNETTE);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  return c;
}
