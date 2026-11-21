// The icons and the link preview, drawn in code from the game's look (direction.md: no image
// files, no art pipeline). Pure: the server renders each once, on first request, and keeps it.
// The rasterizer only knows soft shapes from signed distances (discs, rounded squares, ellipses,
// line segments, rectangles) and radial glows: enough for the robot, the bugs and block letters.
import { ROBOT_RADIUS } from "../web/game/config";
import {
  BUG_LOOKS,
  FLOOR,
  GRID_RGB,
  GRID_SPACING,
  LETTERBOX,
  PALETTE,
  ROBOT_BODY,
  ROBOT_GLOW,
  ROBOT_RIM,
  TEXT_FILL,
  TEXT_STROKE,
  VIGNETTE,
  type BugLook,
  type BugLookId,
} from "../web/game/look";
import { BUG_SPRITE_HALF, ROBOT_SPRITE_HALF } from "../web/game/sprites";
import { encodeIco, encodePng } from "./png";

type Rgb = readonly [number, number, number];

/** "#rrggbb", "r, g, b" or "rgba(r, g, b, a)" as its colour and alpha. */
export function parseColour(s: string): { rgb: Rgb; alpha: number } {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (hex) return { rgb: [parseInt(hex[1]!, 16), parseInt(hex[2]!, 16), parseInt(hex[3]!, 16)], alpha: 1 };
  const parts = s.replace(/^rgba?\(|\)$/g, "").split(",").map((p) => Number(p.trim()));
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) throw new Error(`parseColour: ${s}`);
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}
const rgb = (s: string): Rgb => parseColour(s).rgb;

const SOCKET = "#0b1220";
const CORE = rgb(PALETTE[ROBOT_GLOW]);
const WHITE: Rgb = [255, 255, 255];

/** An opaque RGBA buffer with "over" and additive blending. */
class Raster {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
    background: Rgb,
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = background[0];
      this.data[i + 1] = background[1];
      this.data[i + 2] = background[2];
      this.data[i + 3] = 255;
    }
  }

  private blend(x: number, y: number, c: Rgb, a: number, add: boolean) {
    if (a <= 0) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    for (let k = 0; k < 3; k++) {
      const v = add ? d[i + k]! + c[k]! * a : d[i + k]! + (c[k]! - d[i + k]!) * a;
      d[i + k] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }

  /**
   * Fills where `dist` (a signed distance in pixels, negative inside) is below 0, with a 1 px
   * anti-aliased edge, over the box [x0, x1) x [y0, y1) only.
   */
  shape(x0: number, y0: number, x1: number, y1: number, dist: (x: number, y: number) => number, c: Rgb, alpha = 1) {
    const xa = Math.max(0, Math.floor(x0)), xb = Math.min(this.w, Math.ceil(x1));
    const ya = Math.max(0, Math.floor(y0)), yb = Math.min(this.h, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const cover = Math.max(0, Math.min(1, 0.5 - dist(x + 0.5, y + 0.5)));
        this.blend(x, y, c, cover * alpha, false);
      }
    }
  }

  /** A soft radial glow added on top, its alpha falling with distance by `profile` (0 at the centre, 1 at `r`). */
  glow(cx: number, cy: number, r: number, c: Rgb, alpha: number, profile: (t: number) => number = gameGlow) {
    const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(this.w, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(this.h, Math.ceil(cy + r));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const t = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (t < 1) this.blend(x, y, c, alpha * profile(t), true);
      }
    }
  }

  disc(cx: number, cy: number, r: number, c: Rgb, alpha = 1) {
    this.shape(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, (x, y) => Math.hypot(x - cx, y - cy) - r, c, alpha);
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, alpha = 1) {
    this.shape(x - 1, y - 1, x + w + 1, y + h + 1, (px, py) => Math.max(x - px, px - (x + w), y - py, py - (y + h)), c, alpha);
  }
}

/** The game's glow sprite (sprites.ts glowSprite): stops at 0, 0.2, 0.5 and 1. */
function gameGlow(t: number): number {
  if (t < 0.2) return 1 - t;
  if (t < 0.5) return 0.8 - ((t - 0.2) / 0.3) * (0.8 - 0.267);
  return 0.267 * (1 - (t - 0.5) / 0.5);
}

/** A linear fade from 1 at `from` to 0 at the edge, as the sprites' halos are. */
const halo = (from: number) => (t: number) => (t < from ? 1 : 1 - (t - from) / (1 - from));

function roundedSquareDist(cx: number, cy: number, half: number, corner: number) {
  return (x: number, y: number) => {
    const qx = Math.abs(x - cx) - (half - corner);
    const qy = Math.abs(y - cy) - (half - corner);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
  };
}

/** The robot, `s` pixels per arena unit, centred on (cx, cy): as sprites.ts and render.ts draw it. */
function drawRobot(r: Raster, cx: number, cy: number, s: number) {
  const R = ROBOT_RADIUS * s;
  const half = ROBOT_SPRITE_HALF * ROBOT_RADIUS * s;
  r.glow(cx, cy, half, rgb(ROBOT_RIM), 0x66 / 255, halo(0.8 / ROBOT_SPRITE_HALF));
  const body = roundedSquareDist(cx, cy, R, R * 0.5);
  const box = [cx - R - 2 * s, cy - R - 2 * s, cx + R + 2 * s, cy + R + 2 * s] as const;
  r.shape(...box, body, rgb(ROBOT_BODY));
  const rim = 1.25 * s;
  r.shape(...box, (x, y) => Math.abs(body(x, y)) - rim, rgb(ROBOT_RIM));
  r.disc(cx, cy, R * 0.55, rgb(SOCKET));
  r.glow(cx, cy, R * 1.1, CORE, 1);
  r.glow(cx, cy, R * 0.35, WHITE, 0.9);
}

/** A bug, `s` pixels per arena unit, facing `angle`: shell, wing covers, head, eyes, legs and halo. */
function drawBug(r: Raster, cx: number, cy: number, s: number, look: BugLook, angle: number) {
  const k = look.radius * s;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // Pixel to the bug's own frame, in units of its radius: +x ahead, +y to its right.
  const local = (x: number, y: number): [number, number] => {
    const dx = x - cx, dy = y - cy;
    return [(dx * cos + dy * sin) / k, (-dx * sin + dy * cos) / k];
  };
  const toPx = (u: number, v: number): [number, number] => [cx + (u * cos - v * sin) * k, cy + (u * sin + v * cos) * k];
  const reach = k * 1.8;
  const box = [cx - reach, cy - reach, cx + reach, cy + reach] as const;

  r.glow(cx, cy, k * BUG_SPRITE_HALF, rgb(PALETTE[look.glow]!), 0x55 / 255, halo(0.3 / BUG_SPRITE_HALF));

  // Legs: three a side, each two segments, as line capsules.
  const segment = (a: [number, number], b: [number, number], width: number) => (x: number, y: number) => {
    const [px, py] = local(x, y);
    const bx = b[0] - a[0], by = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((px - a[0]) * bx + (py - a[1]) * by) / (bx * bx + by * by)));
    return (Math.hypot(px - a[0] - bx * t, py - a[1] - by * t) - width / 2) * k;
  };
  const attach = [0.5, 0.05, -0.45];
  const spread = [0.9, 1.57, 2.25];
  for (let i = 0; i < 3; i++) {
    for (const side of [-1, 1]) {
      const a = spread[i]! + 0.2 * (i % 2 === 0 ? 1 : -1) * side;
      const p0: [number, number] = [attach[i]!, side * 0.55];
      const p1: [number, number] = [p0[0] + Math.cos(a) * 0.6, p0[1] + side * Math.sin(a) * 0.6];
      const p2: [number, number] = [p1[0] + Math.cos(a + 0.45) * 0.45, p1[1] + side * Math.sin(a + 0.45) * 0.45];
      r.shape(...box, segment(p0, p1, 0.16), rgb(look.legs));
      r.shape(...box, segment(p1, p2, 0.16), rgb(look.legs));
    }
  }
  const ellipse = (ex: number, ey: number, rx: number, ry: number) => (x: number, y: number) => {
    const [px, py] = local(x, y);
    return (Math.hypot((px - ex) / rx, (py - ey) / ry) - 1) * Math.min(rx, ry) * k;
  };
  r.shape(...box, ellipse(-0.1, 0, 1, 0.8), rgb(look.shell));
  for (const side of [-1, 1]) r.shape(...box, ellipse(-0.2, side * 0.36, 0.6, 0.2), rgb(look.shine), 0.55);
  const [hx, hy] = toPx(0.85, 0);
  r.disc(hx, hy, 0.38 * k, rgb(look.head));
  for (const side of [-1, 1]) {
    const [ex, ey] = toPx(1.02, side * 0.17);
    r.disc(ex, ey, 0.09 * k, rgb(look.legs));
  }
}

/** Block letters, 5 wide and 7 tall: only the ones the preview spells. */
const GLYPHS: Record<string, readonly string[]> = {
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  G: [".####", "#....", "#....", "#.###", "#...#", "#...#", ".###."],
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  W: ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "##.##", "#...#"],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  R: ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  M: ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
};

/** Width of `text` in cells: 5 a letter and 1 between letters. */
const textCells = (text: string) => text.length * 6 - 1;

function drawText(r: Raster, text: string, x: number, y: number, cell: number, c: Rgb, alpha = 1) {
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]!];
    if (!glyph) throw new Error(`no glyph for ${text[i]}`);
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < 5; gx++) {
        if (row[gx] === "#") r.rect(x + (i * 6 + gx) * cell, y + gy * cell, cell - 1, cell - 1, c, alpha);
      }
    });
  }
}

/** The robot as a 64x64 SVG: the favicon. */
export function robotSvg(): string {
  const s = 1.6; // px per arena unit: the body fills 70% of the square
  const c = 32;
  const R = ROBOT_RADIUS * s;
  const haloR = Math.min(ROBOT_SPRITE_HALF * ROBOT_RADIUS * s, 32);
  const f = (n: number) => +n.toFixed(2);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">`,
    `<defs>`,
    `<radialGradient id="halo"><stop offset="${f((ROBOT_RADIUS * 0.8 * s) / haloR)}" stop-color="${ROBOT_RIM}" stop-opacity="0.4"/><stop offset="1" stop-color="${ROBOT_RIM}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="core"><stop offset="0" stop-color="#ffffff"/><stop offset="0.3" stop-color="${PALETTE[ROBOT_GLOW]}" stop-opacity="0.9"/><stop offset="1" stop-color="${PALETTE[ROBOT_GLOW]}" stop-opacity="0"/></radialGradient>`,
    `</defs>`,
    `<rect width="64" height="64" rx="12" fill="${LETTERBOX}"/>`,
    `<circle cx="${c}" cy="${c}" r="${f(haloR)}" fill="url(#halo)"/>`,
    `<rect x="${f(c - R)}" y="${f(c - R)}" width="${f(2 * R)}" height="${f(2 * R)}" rx="${f(R * 0.5)}" fill="${ROBOT_BODY}" stroke="${ROBOT_RIM}" stroke-width="${f(2.5 * s)}"/>`,
    `<circle cx="${c}" cy="${c}" r="${f(R * 0.55)}" fill="${SOCKET}"/>`,
    `<circle cx="${c}" cy="${c}" r="${f(R * 0.8)}" fill="url(#core)"/>`,
    `</svg>`,
  ].join("");
}

/** The robot on the letterbox colour, as a square PNG of `size` pixels: apple-touch-icon and favicon.ico. */
export function robotPng(size: number): Uint8Array<ArrayBuffer> {
  const r = new Raster(size, size, rgb(LETTERBOX));
  drawRobot(r, size / 2, size / 2, (0.35 * size) / ROBOT_RADIUS);
  return encodePng(size, size, r.data);
}

export const PREVIEW_WIDTH = 1200;
export const PREVIEW_HEIGHT = 630;

/** Hand-placed bugs for the preview, around the robot: x, y and kind. */
const PREVIEW_BUGS: readonly [number, number, BugLookId][] = [
  [110, 120, "base"],
  [430, 95, "fast"],
  [520, 250, "base"],
  [60, 330, "fast"],
  [120, 520, "base"],
  [330, 560, "fast"],
  [500, 470, "base"],
  [700, 575, "fast"],
  [1135, 70, "base"],
];

/** The link preview, 1200x630: the arena floor, the robot with its trail, bugs closing in, and the name. */
export function previewPng(): Uint8Array<ArrayBuffer> {
  const W = PREVIEW_WIDTH, H = PREVIEW_HEIGHT;
  const r = new Raster(W, H, rgb(FLOOR));
  const grid = rgb(GRID_RGB);
  const spacing = GRID_SPACING * 1.5;
  for (const [width, alpha] of [[5, 0.035], [2.5, 0.05], [1, 0.13]] as const) {
    for (let x = spacing; x < W; x += spacing) r.rect(x - width / 2, 0, width, H, grid, alpha);
    for (let y = spacing; y < H; y += spacing) r.rect(0, y - width / 2, W, width, grid, alpha);
  }
  // Vignette: darker toward the edges.
  const vignette = parseColour(VIGNETTE);
  const maxD = Math.hypot(W / 2, H / 2);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = Math.hypot(x - W / 2, y - H / 2) / maxD;
      const a = vignette.alpha * Math.max(0, (t - 0.45) / 0.55) ** 2;
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) r.data[i + k] = Math.round(r.data[i + k]! * (1 - a) + vignette.rgb[k]! * a);
    }
  }

  const s = 6; // px per arena unit
  const robot = { x: 300, y: 330 };
  // The trail: fading glows where the robot has just been (up and to the left).
  for (let n = 6; n >= 1; n--) {
    const life = 1 - n / 7;
    r.glow(robot.x - n * 22, robot.y - n * 9, ROBOT_RADIUS * s * (0.6 + 0.5 * life), CORE, 0.35 * life);
  }
  for (const [x, y, id] of PREVIEW_BUGS) {
    const look = BUG_LOOKS[id];
    drawBug(r, x, y, s * (id === "fast" ? 1.1 : 1), look, Math.atan2(robot.y - y, robot.x - x));
  }
  drawRobot(r, robot.x, robot.y, s);

  // The name, in two lines on the right, with a drop shadow.
  const cell = 18;
  const lines = ["BUG", "SWARM"];
  const left = 640;
  const top = (H - (7 * 2 + 2) * cell) / 2;
  const width = textCells("SWARM") * cell;
  lines.forEach((line, i) => {
    const x = left + (width - textCells(line) * cell) / 2;
    const y = top + i * 9 * cell;
    drawText(r, line, x + 6, y + 6, cell, rgb(TEXT_STROKE), 0.9);
    drawText(r, line, x, y, cell, rgb(TEXT_FILL));
  });
  return encodePng(W, H, r.data);
}

/** Content type and bytes of each generated image, by path. */
export type Asset = { type: string; body: Uint8Array<ArrayBuffer> | string };

const RENDER: Record<string, () => Asset> = {
  "/favicon.svg": () => ({ type: "image/svg+xml", body: robotSvg() }),
  "/favicon.ico": () => ({ type: "image/x-icon", body: encodeIco(robotPng(48), 48) }),
  "/apple-touch-icon.png": () => ({ type: "image/png", body: robotPng(180) }),
  "/og.png": () => ({ type: "image/png", body: previewPng() }),
};
export const ASSET_PATHS = Object.keys(RENDER);
const cache = new Map<string, Asset>();

/** The image at `path`, rendered on first use and kept for the life of the process. */
export function asset(path: string): Asset {
  let a = cache.get(path);
  if (!a) {
    const render = RENDER[path];
    if (!render) throw new Error(`no asset at ${path}`);
    cache.set(path, (a = render()));
  }
  return a;
}
