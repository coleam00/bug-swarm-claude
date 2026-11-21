// Draws a frame: the simulation's state plus the effects in fx/. Reads both, changes neither.
// The frame is mostly drawImage of sprites from sprites.ts; glows are additive ('lighter'),
// never shadowBlur. It builds no strings, arrays or closures per frame.
import type { Arena } from "./arena";
import type { Changes } from "./fx/changes";
import type { Particles } from "./fx/particles";
import type { Shake } from "./fx/shake";
import { SQUASH_LABEL, TEXT_SECONDS, type Texts } from "./fx/text";
import { TRAIL_SECONDS, trailSlot, type Trail } from "./fx/trail";
import {
  BUG_LOOKS,
  LETTERBOX,
  ROBOT_GLOW,
  GLOW_WHITE,
  SHOT_CORE,
  SHOT_GLOW,
  TEXT_FILL,
  TEXT_FONT,
  TEXT_STROKE,
  bugLookId,
} from "./look";
import { REVIEW_LASER } from "../../server/rules";
import { LASER_BEAM, MAX_HITS, ROBOT_RADIUS } from "./config";
import { score, type State } from "./sim";
import { BUG_SPRITE_HALF, ROBOT_SPRITE_HALF, buildSprites, type Sprites } from "./sprites";

export type Fx = { changes: Changes; particles: Particles; texts: Texts; trail: Trail; shake: Shake };

const HUD_FONT = "bold 28px system-ui, sans-serif";
const TAU = Math.PI * 2;
/** Leg frames walked forward then back: 0 1 2 3 2 1. */
const LEG_CYCLE = [0, 1, 2, 3, 2, 1];
const PARTICLE_SIZE = 7;
const SHOT_GLOW_LENGTH = 34;
const SHOT_GLOW_WIDTH = 14;
const SHOT_CORE_LENGTH = 18;
const SHOT_CORE_WIDTH = 2.4;

export function createRenderer(ctx: CanvasRenderingContext2D, arena: Arena) {
  const canvas = ctx.canvas;
  let dpr = 1;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  let sprites: Sprites | null = null;
  let builtAt = 0;

  // HUD text is rebuilt only when a value changes.
  let hudScore = -1;
  let hudHits = -1;
  let hudSecond = -1;
  let scoreText = "";
  let hitsText = "";
  let timeText = "";

  /** Takes the layout loop.ts worked out; rebuilds sprites only when their resolution changes. */
  function resize(newDpr: number, newScale: number, newOffX: number, newOffY: number): void {
    dpr = newDpr;
    scale = newScale;
    offX = newOffX;
    offY = newOffY;
    const ppu = dpr * scale;
    if (!sprites || Math.abs(ppu - builtAt) > 0.01) {
      sprites = buildSprites(arena, ppu);
      builtAt = ppu;
    }
  }

  function draw(state: State, fx: Fx): void {
    const s = sprites;
    if (!s) return;
    const k = dpr * scale;
    const ox = dpr * offX + k * fx.shake.offsetX;
    const oy = dpr * offY + k * fx.shake.offsetY;
    const t = state.time;

    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = LETTERBOX;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // The arena, in arena units.
    ctx.setTransform(k, 0, 0, k, ox, oy);
    ctx.drawImage(s.floor, 0, 0, arena.w, arena.h);

    // The robot's trail, newest first, skipping the point under the robot.
    ctx.globalCompositeOperation = "lighter";
    const trail = fx.trail;
    const robotGlow = s.glows[ROBOT_GLOW]!;
    for (let n = 1; n < trail.count; n++) {
      const i = trailSlot(trail, n);
      const life = 1 - trail.age[i]! / TRAIL_SECONDS;
      if (life <= 0) continue;
      const size = ROBOT_RADIUS * (0.6 + 0.9 * life);
      ctx.globalAlpha = 0.45 * life;
      ctx.drawImage(robotGlow, trail.x[i]! - size, trail.y[i]! - size, size * 2, size * 2);
    }
    ctx.globalAlpha = 1;

    // Bugs, each turned to face the robot.
    ctx.globalCompositeOperation = "source-over";
    const { x: rx, y: ry } = state.robot;
    const bugs = state.bugs;
    const phases = fx.changes.phase;
    for (let i = 0; i < bugs.length; i++) {
      const b = bugs[i]!;
      const id = bugLookId(b);
      const look = BUG_LOOKS[id];
      const phase = phases[i]!;
      const dx = rx - b.x;
      const dy = ry - b.y;
      const d = Math.hypot(dx, dy) || 1;
      const wobble = look.jitter * Math.sin(TAU * (t * look.jitterHz + phase));
      const cw = Math.cos(wobble);
      const sw = Math.sin(wobble);
      const c = (dx / d) * cw - (dy / d) * sw;
      const sn = (dy / d) * cw + (dx / d) * sw;
      const u = t * look.legHz + phase;
      const frame = LEG_CYCLE[Math.floor((u - Math.floor(u)) * LEG_CYCLE.length)]!;
      const half = look.radius * BUG_SPRITE_HALF;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * b.x + ox, k * b.y + oy);
      ctx.drawImage(s.bugs[id][frame]!, -half, -half, half * 2, half * 2);
    }

    // Shots: a glow stretched along the flight, with a bright core. The review laser draws
    // them longer, and its top level a little wider.
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = SHOT_CORE;
    const shotGlow = s.glows[SHOT_GLOW]!;
    const laser = state.levels[REVIEW_LASER];
    const beam = LASER_BEAM[laser]!;
    const glowLength = SHOT_GLOW_LENGTH * beam;
    const coreLength = SHOT_CORE_LENGTH * beam;
    const glowWidth = laser > 1 ? SHOT_GLOW_WIDTH * 1.3 : SHOT_GLOW_WIDTH;
    const coreWidth = laser > 1 ? SHOT_CORE_WIDTH * 1.5 : SHOT_CORE_WIDTH;
    for (const shot of state.shots) {
      const v = Math.hypot(shot.vx, shot.vy) || 1;
      const c = shot.vx / v;
      const sn = shot.vy / v;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * shot.x + ox, k * shot.y + oy);
      ctx.drawImage(shotGlow, 6 - glowLength, -glowWidth / 2, glowLength, glowWidth);
      ctx.fillRect(2 - coreLength, -coreWidth / 2, coreLength, coreWidth);
    }

    // Squash particles.
    ctx.setTransform(k, 0, 0, k, ox, oy);
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

    // The robot: body, white while flashing after a hit, then its glowing core.
    ctx.globalCompositeOperation = "source-over";
    const flashing = state.invuln > 0 && Math.floor(state.invuln * 12) % 2 === 0;
    const rh = ROBOT_RADIUS * ROBOT_SPRITE_HALF;
    ctx.drawImage(flashing ? s.robotFlash : s.robot, rx - rh, ry - rh, rh * 2, rh * 2);
    ctx.globalCompositeOperation = "lighter";
    const core = ROBOT_RADIUS * (1.05 + 0.12 * Math.sin(t * 8));
    ctx.drawImage(robotGlow, rx - core, ry - core, core * 2, core * 2);
    const hot = ROBOT_RADIUS * 0.45;
    ctx.drawImage(s.glows[GLOW_WHITE]!, rx - hot, ry - hot, hot * 2, hot * 2);
    ctx.globalCompositeOperation = "source-over";

    // Floating "+10"s, in screen pixels so they stay big on a phone.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const texts = fx.texts;
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
        const x = offX + (texts.x[i]! + fx.shake.offsetX) * scale;
        const y = offY + (texts.y[i]! + fx.shake.offsetY) * scale;
        ctx.strokeText(SQUASH_LABEL, x, y);
        ctx.fillText(SQUASH_LABEL, x, y);
      }
      ctx.globalAlpha = 1;
    }

    // The HUD, steady while the arena shakes.
    const sc = score(state);
    const hitsLeft = Math.max(0, MAX_HITS - state.hits);
    const second = Math.floor(state.time);
    if (sc !== hudScore) scoreText = `Score ${(hudScore = sc)}`;
    if (hitsLeft !== hudHits) hitsText = "♥".repeat((hudHits = hitsLeft)) || "-";
    if (second !== hudSecond) timeText = `${(hudSecond = second)}s`;
    ctx.font = HUD_FONT;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#f8fafc";
    const w = canvas.width / dpr;
    ctx.textAlign = "left";
    ctx.fillText(scoreText, 16, 16);
    ctx.textAlign = "center";
    ctx.fillText(timeText, w / 2, 16);
    ctx.textAlign = "right";
    ctx.fillStyle = "#f43f5e";
    ctx.fillText(hitsText, w - 16, 16);
  }

  return { resize, draw };
}
