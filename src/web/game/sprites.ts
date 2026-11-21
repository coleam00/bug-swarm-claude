// Pre-rendered sprites on offscreen canvases, drawn in code from look.ts. Anything with a glow
// or many path segments is drawn once here, so a frame is mostly drawImage calls and never uses
// shadowBlur. Browser only: render.ts draws with it, the server's art.ts reads only its sizes,
// and nothing here runs at import.
import type { Arena } from "./arena";
import {
  ARENA_EDGE,
  BUG_LOOK_IDS,
  BUG_LOOKS,
  FLOOR,
  GRID_RGB,
  GRID_SPACING,
  PALETTE,
  ROBOT_BODY,
  ROBOT_MARK,
  ROBOT_MARK_OUTLINE,
  ROBOT_MARK_OUTLINE_WIDTH,
  ROBOT_MARK_RADIUS,
  ROBOT_MARK_WIDTH,
  ROBOT_RIM,
  VIGNETTE,
  type BugLook,
  type BugLookId,
} from "./look";
import { ROBOT_RADIUS } from "./config";

/** Leg poses per bug look; render.ts walks them 0 1 2 3 2 1. */
export const LEG_FRAMES = 4;
/** A bug sprite's half-size, in multiples of the look's radius (room for legs and antennae). */
export const BUG_SPRITE_HALF = 1.9;
/** The robot sprite's half-size, in multiples of ROBOT_RADIUS (room for the halo). */
export const ROBOT_SPRITE_HALF = 1.8;
/** The robot marker sprite's half-size, in multiples of ROBOT_RADIUS: the ring and its outline. */
export const ROBOT_MARK_HALF = (ROBOT_MARK_RADIUS + ROBOT_MARK_OUTLINE_WIDTH) / ROBOT_RADIUS;
const GLOW_PX = 64;

export type Sprites = {
  /** The whole arena floor: grid, edge and vignette, at device resolution. */
  floor: HTMLCanvasElement;
  /** One soft glow per PALETTE entry, for additive blending. */
  glows: HTMLCanvasElement[];
  bugs: Record<BugLookId, HTMLCanvasElement[]>;
  robot: HTMLCanvasElement;
  robotFlash: HTMLCanvasElement;
  /** The ring drawn over the robot so it is found in a full swarm. */
  robotMark: HTMLCanvasElement;
};

/** Builds every sprite for an arena drawn at `pxPerUnit` device pixels per arena unit. */
export function buildSprites(arena: Arena, pxPerUnit: number): Sprites {
  const bugs = {} as Record<BugLookId, HTMLCanvasElement[]>;
  for (const id of BUG_LOOK_IDS) {
    const look = BUG_LOOKS[id];
    bugs[id] = [];
    for (let f = 0; f < LEG_FRAMES; f++) bugs[id].push(bugSprite(look, f, pxPerUnit));
  }
  return {
    floor: floorSprite(arena, pxPerUnit),
    glows: PALETTE.map(glowSprite),
    bugs,
    robot: robotSprite(pxPerUnit, false),
    robotFlash: robotSprite(pxPerUnit, true),
    robotMark: robotMarkSprite(pxPerUnit),
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  return [c, ctx];
}

function floorSprite(arena: Arena, ppu: number): HTMLCanvasElement {
  const { w, h } = arena;
  const [c, ctx] = canvas(w * ppu, h * ppu);
  ctx.scale(c.width / w, c.height / h);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, w, h);

  const grid = (width: number, alpha: number) => {
    ctx.lineWidth = width;
    ctx.strokeStyle = `rgba(${GRID_RGB}, ${alpha})`;
    ctx.beginPath();
    for (let x = GRID_SPACING; x < w; x += GRID_SPACING) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let y = GRID_SPACING; y < h; y += GRID_SPACING) {
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();
  };
  grid(5, 0.035);
  grid(2.5, 0.05);
  grid(1, 0.13);

  ctx.lineWidth = 2;
  ctx.strokeStyle = ARENA_EDGE;
  ctx.strokeRect(1, 1, w - 2, h - 2);

  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) / 2);
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, VIGNETTE);
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  return c;
}

function glowSprite(colour: string): HTMLCanvasElement {
  const [c, ctx] = canvas(GLOW_PX, GLOW_PX);
  const r = GLOW_PX / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, colour);
  g.addColorStop(0.2, `${colour}cc`);
  g.addColorStop(0.5, `${colour}44`);
  g.addColorStop(1, `${colour}00`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, GLOW_PX, GLOW_PX);
  return c;
}

/** Ping-pong leg angle for frame `f`, from -1 to 1. */
function legPose(f: number): number {
  return -1 + (2 * f) / (LEG_FRAMES - 1);
}

/** One bug, facing +x, with its legs in pose `frame`. */
function bugSprite(look: BugLook, frame: number, ppu: number): HTMLCanvasElement {
  const r = look.radius;
  const half = r * BUG_SPRITE_HALF;
  const [c, ctx] = canvas(half * 2 * ppu, half * 2 * ppu);
  ctx.scale(c.width / (half * 2), c.height / (half * 2));
  ctx.translate(half, half);

  const glow = PALETTE[look.glow]!;
  const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, half);
  halo.addColorStop(0, `${glow}55`);
  halo.addColorStop(1, `${glow}00`);
  ctx.fillStyle = halo;
  ctx.fillRect(-half, -half, half * 2, half * 2);

  // Six legs, three a side, in an alternating tripod: each leg swings opposite its neighbours.
  const swing = look.legSwing * legPose(frame);
  ctx.strokeStyle = look.legs;
  ctx.lineWidth = r * 0.16;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const attach = [0.5, 0.05, -0.45];
  const spread = [0.9, 1.57, 2.25]; // radians from straight ahead
  for (let i = 0; i < 3; i++) {
    for (const side of [-1, 1]) {
      const sign = (i % 2 === 0 ? 1 : -1) * side;
      const a = spread[i]! + swing * sign;
      const x0 = attach[i]! * r;
      const y0 = side * 0.55 * r;
      const kx = x0 + Math.cos(a) * 0.6 * r;
      const ky = y0 + side * Math.sin(a) * 0.6 * r;
      const fa = a + 0.45;
      ctx.moveTo(x0, y0);
      ctx.lineTo(kx, ky);
      ctx.lineTo(kx + Math.cos(fa) * 0.45 * r, ky + side * Math.sin(fa) * 0.45 * r);
    }
  }
  // Antennae.
  for (const side of [-1, 1]) {
    ctx.moveTo(1.1 * r, side * 0.12 * r);
    ctx.quadraticCurveTo(1.35 * r, side * 0.2 * r, 1.55 * r, side * 0.5 * r);
  }
  ctx.stroke();

  // Shell, wing covers and seam.
  ctx.fillStyle = look.shell;
  ctx.beginPath();
  ctx.ellipse(-0.1 * r, 0, r, 0.8 * r, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = look.shine;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(-0.2 * r, side * 0.36 * r, 0.6 * r, 0.2 * r, side * 0.08, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = look.head;
  ctx.lineWidth = r * 0.08;
  ctx.beginPath();
  ctx.moveTo(0.55 * r, 0);
  ctx.lineTo(-1.0 * r, 0);
  ctx.stroke();

  // Head and eyes.
  ctx.fillStyle = look.head;
  ctx.beginPath();
  ctx.arc(0.85 * r, 0, 0.38 * r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = look.legs;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(1.02 * r, side * 0.17 * r, 0.09 * r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** The robot's rounded body, or its all-white flash when hit. Its core glow is drawn live. */
function robotSprite(ppu: number, flash: boolean): HTMLCanvasElement {
  const R = ROBOT_RADIUS;
  const half = R * ROBOT_SPRITE_HALF;
  const [c, ctx] = canvas(half * 2 * ppu, half * 2 * ppu);
  ctx.scale(c.width / (half * 2), c.height / (half * 2));
  ctx.translate(half, half);

  const rim = flash ? "#ffffff" : ROBOT_RIM;
  const halo = ctx.createRadialGradient(0, 0, R * 0.8, 0, 0, half);
  halo.addColorStop(0, `${rim}66`);
  halo.addColorStop(1, `${rim}00`);
  ctx.fillStyle = halo;
  ctx.fillRect(-half, -half, half * 2, half * 2);

  roundedSquare(ctx, R, R * 0.5);
  ctx.fillStyle = flash ? "#ffffff" : ROBOT_BODY;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = rim;
  ctx.stroke();

  // A darker socket the core glows out of.
  ctx.fillStyle = flash ? "#e2e8f0" : "#0b1220";
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.55, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

/** A white ring on a darker, wider one, so it reads over bugs, glows and the bare floor alike. */
function robotMarkSprite(ppu: number): HTMLCanvasElement {
  const half = ROBOT_RADIUS * ROBOT_MARK_HALF;
  const [c, ctx] = canvas(half * 2 * ppu, half * 2 * ppu);
  ctx.scale(c.width / (half * 2), c.height / (half * 2));
  ctx.translate(half, half);
  ctx.beginPath();
  ctx.arc(0, 0, ROBOT_MARK_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = ROBOT_MARK_OUTLINE_WIDTH;
  ctx.strokeStyle = ROBOT_MARK_OUTLINE;
  ctx.stroke();
  ctx.lineWidth = ROBOT_MARK_WIDTH;
  ctx.strokeStyle = ROBOT_MARK;
  ctx.stroke();
  return c;
}

function roundedSquare(ctx: CanvasRenderingContext2D, half: number, corner: number): void {
  ctx.beginPath();
  ctx.moveTo(-half + corner, -half);
  ctx.arcTo(half, -half, half, half, corner);
  ctx.arcTo(half, half, -half, half, corner);
  ctx.arcTo(-half, half, -half, -half, corner);
  ctx.arcTo(-half, -half, half, -half, corner);
  ctx.closePath();
}
