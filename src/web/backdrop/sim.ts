// The start screen's backdrop, as a simulation: four robots, Tabs and Spaces in turn, strafe in
// two lanes clear of the title and shoot at bugs crawling in from the edges, which pop when hit.
// Decoration only: robots never die and nothing is scored. Pure, like the game's sim: time comes
// in as a step, randomness from a seeded generator, and nothing reads the DOM. Every pool is a
// fixed typed array made once, so a step allocates nothing.
import { TEAMS } from "../../server/rules";
import type { Arena } from "../game/arena";
import { ARENA_AREA, BUG_KINDS, ROBOT_RADIUS } from "../game/config";
import { BUG_LOOK_IDS, BUG_LOOKS } from "../game/look";
import { createRng, nextRandom, type Rng } from "../game/rng";

export const ROBOTS = 4;
export const BUGS_MAX = 24;
/** Bugs kept alive: below this, one spawns every SPAWN_SECONDS. */
export const BUGS_TARGET = 14;
export const SHOTS_MAX = 32;
/** The longest step taken: a tab that comes back after minutes moves on by one of these. */
export const MAX_STEP = 0.05;
/** Lanes, as fractions of the height: above and below the title. */
export const LANES = [0.18, 0.82] as const;
/** How far a robot bobs off its lane, as a fraction of the height. */
export const LANE_BOB = 0.03;
/** Grid cells a second the floor drifts by. */
export const DRIFT_CELLS = 0.3;
const SPAWN_SECONDS = 0.2;
/** How far off the bug a shot may go, either way, in radians: some miss, so the swarm keeps up. */
const SPREAD = 0.12;
const SHOT_SPEED = 600;
const SHOT_LIFE = 1;
const RANGE = 460;
/** A bug this close to a robot's centre is gone, with a pop. */
const REACH = ROBOT_RADIUS * 1.5;
const TAU = Math.PI * 2;

export type Backdrop = {
  world: Arena;
  rng: Rng;
  time: number;
  /** The floor's drift, in grid cells, in [0, 1). */
  drift: number;
  robotX: Float64Array;
  robotY: Float64Array;
  /** Where each robot's gun points, in radians. */
  robotAim: Float64Array;
  /** Index into TEAMS. */
  robotTeam: Uint8Array;
  /** Strafe centre, as a fraction of the width. */
  robotCentre: Float64Array;
  /** Strafe reach either side, as a fraction of the width. */
  robotReach: Float64Array;
  robotRate: Float64Array;
  robotPhase: Float64Array;
  robotCooldown: Float64Array;
  bugX: Float64Array;
  bugY: Float64Array;
  /** Heading, in radians: draw.ts turns the sprite to it. */
  bugHeading: Float64Array;
  bugSpeed: Float64Array;
  bugPhase: Float64Array;
  /** Index into BUG_LOOK_IDS. */
  bugLook: Uint8Array;
  bugAlive: Uint8Array;
  bugsLive: number;
  shotX: Float64Array;
  shotY: Float64Array;
  shotVx: Float64Array;
  shotVy: Float64Array;
  /** Seconds left; a slot is free at 0. */
  shotLife: Float64Array;
  /** Index into TEAMS: whose shot it is. */
  shotTeam: Uint8Array;
  shotCursor: number;
  spawnClock: number;
  /** Bugs popped so far, shot or reaching a robot. */
  pops: number;
};

/** Called once per popped bug, with where it was and its look's glow (a PALETTE index). */
export type OnPop = (x: number, y: number, glow: number) => void;

/** The backdrop's world for a screen: the game arena's area at the screen's own aspect, so bugs are game-sized and nothing is cropped. */
export function backdropWorld(cssW: number, cssH: number): Arena {
  const ratio = Math.max(1, cssW) / Math.max(1, cssH);
  return { w: Math.sqrt(ARENA_AREA * ratio), h: Math.sqrt(ARENA_AREA / ratio) };
}

export function createBackdrop(seed: number, world: Arena): Backdrop {
  const rng = createRng(seed);
  const b: Backdrop = {
    world: { w: world.w, h: world.h },
    rng,
    time: 0,
    drift: 0,
    robotX: new Float64Array(ROBOTS),
    robotY: new Float64Array(ROBOTS),
    robotAim: new Float64Array(ROBOTS),
    robotTeam: new Uint8Array(ROBOTS),
    robotCentre: new Float64Array(ROBOTS),
    robotReach: new Float64Array(ROBOTS),
    robotRate: new Float64Array(ROBOTS),
    robotPhase: new Float64Array(ROBOTS),
    robotCooldown: new Float64Array(ROBOTS),
    bugX: new Float64Array(BUGS_MAX),
    bugY: new Float64Array(BUGS_MAX),
    bugHeading: new Float64Array(BUGS_MAX),
    bugSpeed: new Float64Array(BUGS_MAX),
    bugPhase: new Float64Array(BUGS_MAX),
    bugLook: new Uint8Array(BUGS_MAX),
    bugAlive: new Uint8Array(BUGS_MAX),
    bugsLive: 0,
    shotX: new Float64Array(SHOTS_MAX),
    shotY: new Float64Array(SHOTS_MAX),
    shotVx: new Float64Array(SHOTS_MAX),
    shotVy: new Float64Array(SHOTS_MAX),
    shotLife: new Float64Array(SHOTS_MAX),
    shotTeam: new Uint8Array(SHOTS_MAX),
    shotCursor: 0,
    spawnClock: 0,
    pops: 0,
  };
  for (let i = 0; i < ROBOTS; i++) {
    // Two to a lane, one each side of centre; teams alternate so each lane has one of each.
    b.robotTeam[i] = i % TEAMS.length;
    b.robotCentre[i] = i % 2 === 0 ? 0.3 : 0.7;
    b.robotReach[i] = 0.12 + 0.08 * nextRandom(rng);
    b.robotRate[i] = 0.5 + 0.5 * nextRandom(rng);
    b.robotPhase[i] = TAU * nextRandom(rng);
    b.robotCooldown[i] = 0.2 * i;
    b.robotAim[i] = i < 2 ? Math.PI / 2 : -Math.PI / 2;
  }
  placeRobots(b);
  // The first bugs are already on screen, so the first frame isn't empty.
  for (let n = 0; n < BUGS_TARGET; n++) spawnBug(b, nextRandom(rng) * b.world.w, nextRandom(rng) * b.world.h);
  return b;
}

/** The lane a robot keeps to, in world units. */
export function laneY(b: Backdrop, i: number): number {
  return LANES[i < 2 ? 0 : 1] * b.world.h;
}

/** Moves the backdrop on by `dt` seconds (at most MAX_STEP), calling `onPop` for each bug popped. */
export function stepBackdrop(b: Backdrop, dt: number, onPop: OnPop): void {
  const step = Math.min(Math.max(dt, 0), MAX_STEP);
  if (step === 0) return;
  b.time += step;
  b.drift = (b.drift + DRIFT_CELLS * step) % 1;
  placeRobots(b);

  // Robots fire at the nearest bug in range.
  for (let i = 0; i < ROBOTS; i++) {
    b.robotCooldown[i]! -= step;
    if (b.robotCooldown[i]! > 0) continue;
    const rx = b.robotX[i]!;
    const ry = b.robotY[i]!;
    let best = -1;
    let bestD = RANGE * RANGE;
    for (let j = 0; j < BUGS_MAX; j++) {
      if (!b.bugAlive[j]) continue;
      const d = (b.bugX[j]! - rx) ** 2 + (b.bugY[j]! - ry) ** 2;
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) {
      b.robotCooldown[i] = 0.1;
      continue;
    }
    const aim = Math.atan2(b.bugY[best]! - ry, b.bugX[best]! - rx) + SPREAD * (2 * nextRandom(b.rng) - 1);
    b.robotAim[i] = aim;
    const s = b.shotCursor;
    b.shotCursor = (s + 1) % SHOTS_MAX;
    b.shotX[s] = rx + Math.cos(aim) * ROBOT_RADIUS;
    b.shotY[s] = ry + Math.sin(aim) * ROBOT_RADIUS;
    b.shotVx[s] = Math.cos(aim) * SHOT_SPEED;
    b.shotVy[s] = Math.sin(aim) * SHOT_SPEED;
    b.shotLife[s] = SHOT_LIFE;
    b.shotTeam[s] = b.robotTeam[i]!;
    b.robotCooldown[i] = 0.5 + 0.3 * nextRandom(b.rng);
  }

  // Shots fly, and pop the first bug they touch.
  const { w, h } = b.world;
  for (let s = 0; s < SHOTS_MAX; s++) {
    if (b.shotLife[s]! <= 0) continue;
    b.shotLife[s]! -= step;
    b.shotX[s]! += b.shotVx[s]! * step;
    b.shotY[s]! += b.shotVy[s]! * step;
    const x = b.shotX[s]!;
    const y = b.shotY[s]!;
    if (b.shotLife[s]! <= 0 || x < 0 || y < 0 || x > w || y > h) {
      b.shotLife[s] = 0;
      continue;
    }
    for (let j = 0; j < BUGS_MAX; j++) {
      if (!b.bugAlive[j]) continue;
      const r = BUG_KINDS[b.bugLook[j]!]!.radius + 3;
      if ((b.bugX[j]! - x) ** 2 + (b.bugY[j]! - y) ** 2 < r * r) {
        b.shotLife[s] = 0;
        popBug(b, j, onPop);
        break;
      }
    }
  }

  // Bugs crawl at the nearest robot, wobbling; one that gets there pops.
  for (let j = 0; j < BUGS_MAX; j++) {
    if (!b.bugAlive[j]) continue;
    const x = b.bugX[j]!;
    const y = b.bugY[j]!;
    let tx = 0;
    let ty = 0;
    let bestD = Infinity;
    for (let i = 0; i < ROBOTS; i++) {
      const d = (b.robotX[i]! - x) ** 2 + (b.robotY[i]! - y) ** 2;
      if (d < bestD) {
        bestD = d;
        tx = b.robotX[i]!;
        ty = b.robotY[i]!;
      }
    }
    if (bestD < REACH * REACH) {
      popBug(b, j, onPop);
      continue;
    }
    const heading = Math.atan2(ty - y, tx - x) + 0.35 * Math.sin(b.time * 2.2 + TAU * b.bugPhase[j]!);
    b.bugHeading[j] = heading;
    b.bugX[j] = Math.min(Math.max(x + Math.cos(heading) * b.bugSpeed[j]! * step, 0), w);
    b.bugY[j] = Math.min(Math.max(y + Math.sin(heading) * b.bugSpeed[j]! * step, 0), h);
  }

  // New bugs come in from a random point on the edge.
  b.spawnClock += step;
  if (b.bugsLive >= BUGS_TARGET) b.spawnClock = 0;
  else if (b.spawnClock >= SPAWN_SECONDS) {
    b.spawnClock -= SPAWN_SECONDS;
    const along = nextRandom(b.rng);
    const edge = Math.floor(nextRandom(b.rng) * 4);
    spawnBug(b, edge === 0 ? 0 : edge === 1 ? w : along * w, edge === 2 ? 0 : edge === 3 ? h : along * h);
  }
}

/** Takes the backdrop to a new world (a resize), scaling every position so nothing is left outside it. */
export function resizeBackdrop(b: Backdrop, world: Arena): void {
  const sx = world.w / b.world.w;
  const sy = world.h / b.world.h;
  b.world.w = world.w;
  b.world.h = world.h;
  for (let j = 0; j < BUGS_MAX; j++) {
    b.bugX[j]! *= sx;
    b.bugY[j]! *= sy;
  }
  for (let s = 0; s < SHOTS_MAX; s++) {
    b.shotX[s]! *= sx;
    b.shotY[s]! *= sy;
  }
  placeRobots(b);
}

function placeRobots(b: Backdrop): void {
  const { w, h } = b.world;
  for (let i = 0; i < ROBOTS; i++) {
    const u = b.time * b.robotRate[i]! + b.robotPhase[i]!;
    b.robotX[i] = w * (b.robotCentre[i]! + b.robotReach[i]! * Math.sin(u));
    b.robotY[i] = laneY(b, i) + h * LANE_BOB * Math.sin(1.7 * u);
  }
}

function spawnBug(b: Backdrop, x: number, y: number): void {
  const j = b.bugAlive.indexOf(0);
  if (j < 0) return;
  // One bug in four is the small, quick kind.
  const look = nextRandom(b.rng) < 0.25 ? 1 : 0;
  b.bugAlive[j] = 1;
  b.bugLook[j] = look;
  b.bugX[j] = x;
  b.bugY[j] = y;
  b.bugPhase[j] = nextRandom(b.rng);
  b.bugSpeed[j] = (look === 1 ? 60 : 40) + 15 * nextRandom(b.rng);
  b.bugHeading[j] = 0;
  b.bugsLive++;
}

function popBug(b: Backdrop, j: number, onPop: OnPop): void {
  b.bugAlive[j] = 0;
  b.bugsLive--;
  b.pops++;
  onPop(b.bugX[j]!, b.bugY[j]!, BUG_LOOKS[BUG_LOOK_IDS[b.bugLook[j]!]!].glow);
}
