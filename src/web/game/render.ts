// Draws a frame: the simulation's state plus the effects in fx/. Reads both, changes neither.
// The frame is mostly drawImage of sprites from sprites.ts; glows are additive ('lighter'),
// never shadowBlur. It builds no strings, arrays or closures per frame.
import type { Arena } from "./arena";
import type { Changes } from "./fx/changes";
import type { Particles } from "./fx/particles";
import { POP_SECONDS, type Pops } from "./fx/pop";
import type { Shake } from "./fx/shake";
import { SQUASH_LABEL, TEXT_SECONDS, type Texts } from "./fx/text";
import { TRAIL_SECONDS, trailSlot, type Trail } from "./fx/trail";
import {
  BOMB_CHARGE,
  BOMB_CHARGE_RADIUS,
  BOMB_CHARGE_WIDTH,
  BOMB_RING,
  BOMB_RING_GLOW_WIDTH,
  BOMB_RING_WIDTH,
  BUG_LOOKS,
  DRONE_BODY,
  DRONE_GLOW,
  DRONE_SHOT_CORE,
  LETTERBOX,
  POP_GROWTH,
  ROBOT_GLOW,
  GLOW_WHITE,
  SHOT_CORE,
  SHIELD_COLOUR,
  SHIELD_INNER,
  SHIELD_RADIUS,
  SHOT_GLOW,
  TEXT_FILL,
  TEXT_FONT,
  TEXT_STROKE,
  bugLookId,
} from "./look";
import { REFACTOR_BOMB, REVIEW_LASER } from "../../server/rules";
import { DRONE_RADIUS, LASER_BEAM, MAX_HITS, ROBOT_RADIUS } from "./config";
import { bombCharge, bombRing, droneCount, droneX, droneY, score, type State } from "./sim";
import { BUG_SPRITE_HALF, ROBOT_SPRITE_HALF, buildSprites, type Sprites } from "./sprites";

export type Fx = { changes: Changes; particles: Particles; texts: Texts; trail: Trail; shake: Shake; pops: Pops };

/** The F readout. loop.ts refreshes the numbers twice a second and bumps `reading` when it does. */
export type Stats = { show: boolean; fps: number; bugs: number; effects: number; reading: number };

const HUD_FONT = "bold 28px system-ui, sans-serif";
const STATS_FONT = "bold 16px system-ui, sans-serif";
/** The readout's line, under the HUD's top row. */
const STATS_Y = 52;
const TAU = Math.PI * 2;
/** Leg frames walked forward then back: 0 1 2 3 2 1. */
const LEG_CYCLE = [0, 1, 2, 3, 2, 1];
const PARTICLE_SIZE = 7;
const SHOT_GLOW_LENGTH = 34;
const SHOT_GLOW_WIDTH = 14;
const SHOT_CORE_LENGTH = 18;
const SHOT_CORE_WIDTH = 2.4;
/** A drone's shot is a smaller streak than the gun's, and the laser never lengthens it. */
const DRONE_SHOT_SCALE = 0.6;

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
  let statsReading = -1;
  let statsText = "";

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

  function draw(state: State, fx: Fx, stats: Stats): void {
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

    // Shots: a glow stretched along the flight, with a bright core. The review laser draws the
    // gun's longer, and its top level a little wider; a drone's are small and violet.
    ctx.globalCompositeOperation = "lighter";
    const shotGlow = s.glows[SHOT_GLOW]!;
    const droneGlow = s.glows[DRONE_GLOW]!;
    const laser = state.levels[REVIEW_LASER];
    const beam = LASER_BEAM[laser]!;
    const glowLength = SHOT_GLOW_LENGTH * beam;
    const coreLength = SHOT_CORE_LENGTH * beam;
    const glowWidth = laser > 1 ? SHOT_GLOW_WIDTH * 1.3 : SHOT_GLOW_WIDTH;
    const coreWidth = laser > 1 ? SHOT_CORE_WIDTH * 1.5 : SHOT_CORE_WIDTH;
    const d = DRONE_SHOT_SCALE;
    for (const shot of state.shots) {
      const v = Math.hypot(shot.vx, shot.vy) || 1;
      const c = shot.vx / v;
      const sn = shot.vy / v;
      ctx.setTransform(k * c, k * sn, -k * sn, k * c, k * shot.x + ox, k * shot.y + oy);
      if (shot.drone) {
        ctx.fillStyle = DRONE_SHOT_CORE;
        ctx.drawImage(droneGlow, 6 * d - SHOT_GLOW_LENGTH * d, (-SHOT_GLOW_WIDTH * d) / 2, SHOT_GLOW_LENGTH * d, SHOT_GLOW_WIDTH * d);
        ctx.fillRect(2 * d - SHOT_CORE_LENGTH * d, (-SHOT_CORE_WIDTH * d) / 2, SHOT_CORE_LENGTH * d, SHOT_CORE_WIDTH * d);
      } else {
        ctx.fillStyle = SHOT_CORE;
        ctx.drawImage(shotGlow, 6 - glowLength, -glowWidth / 2, glowLength, glowWidth);
        ctx.fillRect(2 - coreLength, -coreWidth / 2, coreLength, coreWidth);
      }
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

    // The refactor bomb: a ring sweeping out from the robot to the farthest corner as it goes
    // off, and while it recharges an arc around the robot that fills clockwise.
    const ring = bombRing(state);
    if (ring >= 0) {
      const far = Math.hypot(Math.max(rx, arena.w - rx), Math.max(ry, arena.h - ry));
      ctx.strokeStyle = BOMB_RING;
      ctx.beginPath();
      ctx.arc(rx, ry, ring * far, 0, TAU);
      ctx.globalAlpha = 0.25 * (1 - ring);
      ctx.lineWidth = BOMB_RING_GLOW_WIDTH * (1 - 0.5 * ring);
      ctx.stroke();
      ctx.globalAlpha = 1 - ring;
      ctx.lineWidth = BOMB_RING_WIDTH * (1 - 0.5 * ring);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    const charge = bombCharge(state);
    if (state.levels[REFACTOR_BOMB] > 0 && charge < 1) {
      ctx.strokeStyle = BOMB_CHARGE;
      ctx.lineWidth = BOMB_CHARGE_WIDTH;
      ctx.beginPath();
      ctx.arc(rx, ry, BOMB_CHARGE_RADIUS, -Math.PI / 2, -Math.PI / 2 + TAU * charge);
      ctx.stroke();
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

    // CI drones on their orbit: a small dark body, then its own pulsing violet glow.
    const drones = droneCount(state);
    if (drones > 0) {
      const glow = DRONE_RADIUS * (2.2 + 0.25 * Math.sin(t * 10));
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = DRONE_BODY;
      for (let i = 0; i < drones; i++) {
        ctx.beginPath();
        ctx.arc(droneX(state, i), droneY(state, i), DRONE_RADIUS, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < drones; i++) {
        ctx.drawImage(droneGlow, droneX(state, i) - glow, droneY(state, i) - glow, glow * 2, glow * 2);
      }
    }
    // The test shield: a bubble while it holds a charge (a second ring at 2), and a ring that
    // grows and fades where it popped.
    ctx.strokeStyle = SHIELD_COLOUR;
    ctx.fillStyle = SHIELD_COLOUR;
    if (state.shield > 0) {
      ctx.globalAlpha = 0.08;
      ctx.beginPath();
      ctx.arc(rx, ry, SHIELD_RADIUS, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.55 + 0.15 * Math.sin(t * 4);
      ctx.stroke();
      if (state.shield > 1) {
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(rx, ry, SHIELD_RADIUS * SHIELD_INNER, 0, TAU);
        ctx.stroke();
      }
    }
    const pops = fx.pops;
    if (pops.live > 0) {
      ctx.lineWidth = 3;
      for (let i = 0; i < pops.life.length; i++) {
        const life = pops.life[i]!;
        if (life <= 0) continue;
        const f = 1 - life / POP_SECONDS;
        ctx.globalAlpha = 1 - f;
        ctx.beginPath();
        ctx.arc(pops.x[i]!, pops.y[i]!, SHIELD_RADIUS * (1 + (POP_GROWTH - 1) * f), 0, TAU);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
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

    if (stats.show) {
      if (stats.reading !== statsReading) {
        statsReading = stats.reading;
        statsText = `${Math.round(stats.fps)} fps · ${stats.bugs} bugs · ${stats.effects} fx`;
      }
      ctx.font = STATS_FONT;
      ctx.textAlign = "left";
      ctx.fillStyle = "#94a3b8";
      ctx.fillText(statsText, 16, STATS_Y);
    }
  }

  return { resize, draw };
}
