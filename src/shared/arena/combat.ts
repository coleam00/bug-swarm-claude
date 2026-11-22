// Shots, heat and the hit streak (#55), stepped by sim.ts stepArena. Pure and deterministic.
import {
  BARREL,
  DT,
  FIRE_RATE,
  HEAT_COOL_PER_S,
  HEAT_LOCK_S,
  HEAT_PER_SHOT,
  SHOT_RADIUS,
  SHOT_RANGE,
  SHOT_SPEED,
  SHOT_SPREAD,
  STREAK_STEPS,
  WORLD_H,
  WORLD_W,
} from "./constants";
import { bugDef } from "./bugs/registry";
import { laserPierce } from "./pickups/laser";
import { nextRandom } from "./rng";
import type { ArenaState, Bug, Player, Shot } from "./sim";

/** The streak multiplier for `streak` hits in a row: x1, x1.5 from 5, x2 from 10, x3 from 20. */
export function mult(streak: number): number {
  for (const [hits, m] of STREAK_STEPS) if (streak >= hits) return m;
  return 1;
}

const LOCK_TICKS = Math.round(HEAT_LOCK_S / DT);
/** Heat counts as full from just under 1, so 18 shots of 1/18 lock despite rounding. */
const FULL_HEAT = 1 - 1e-9;

/**
 * How far a shot has flown at snapshot tick `tick`, when it was reported fired in the snapshot of
 * tick `firedTick`: a shot fired during a step also flies its first 45 units in that step. The
 * browser draws shots with this, so it and the server agree to the tick.
 */
export function shotTravelAt(firedTick: number, tick: number): number {
  return Math.min(SHOT_RANGE, Math.max(0, SHOT_SPEED * DT * (tick - firedTick + 1)));
}

/**
 * Fire and heat for one alive player, one tick:
 * - locked: count the lock down, heat draining to 0 over it; no shot;
 * - fire held: shots leave the barrel along the aim (plus spread) every 1/FIRE_RATE s, each adding
 *   HEAT_PER_SHOT; full heat locks the gun for HEAT_LOCK_S;
 * - fire released: heat cools, and the cooldown runs out without banking shots.
 */
export function stepFire(state: ArenaState, p: Player): void {
  if (p.lockTicks > 0) {
    p.lockTicks--;
    p.heat = p.lockTicks / LOCK_TICKS;
    p.fireCooldown = Math.max(p.fireCooldown - DT, 0);
    return;
  }
  if (!p.input.fire) {
    // The gun cools only once its cooldown has run out, so tapping fire between shots does not dodge heat.
    if (p.fireCooldown <= 0) p.heat = Math.max(0, p.heat - HEAT_COOL_PER_S * DT);
    p.fireCooldown = Math.max(p.fireCooldown - DT, 0);
    return;
  }
  p.fireCooldown -= DT;
  while (p.fireCooldown <= 0 && p.lockTicks === 0) {
    fireShot(state, p);
    p.heat += HEAT_PER_SHOT;
    p.fireCooldown += 1 / FIRE_RATE;
    if (p.heat >= FULL_HEAT) {
      p.heat = 1;
      p.lockTicks = LOCK_TICKS;
    }
  }
}

function fireShot(state: ArenaState, p: Player): void {
  const angle = p.aim + (nextRandom(state.rng) * 2 - 1) * SHOT_SPREAD;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const id = state.nextShotId++;
  const x = p.x + Math.cos(p.aim) * BARREL;
  const y = p.y + Math.sin(p.aim) * BARREL;
  // The review laser (#73, pickups/laser.ts) is stamped on the shot as it leaves.
  const pierce = laserPierce(p);
  state.shots.push({ id, owner: p.id, life: p.lifeStartTick, x, y, dx, dy, travelled: 0, pierce, laser: pierce > 1, hitA: 0, hitB: 0, hits: 0 });
  state.events.shotsFired.push({ id, owner: p.id, x, y, angle, laser: pierce > 1 });
}

/**
 * Where along the segment from (x, y) in unit direction (dx, dy), of length `len`, it first
 * touches the circle at (cx, cy) of radius `r`: 0 if it starts inside, else the entry distance,
 * or -1 if it misses. A swept test: a shot moves 45 units a tick against a bug about 30 units across.
 */
export function segmentHit(x: number, y: number, dx: number, dy: number, len: number, cx: number, cy: number, r: number): number {
  const fx = x - cx;
  const fy = y - cy;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const b = fx * dx + fy * dy;
  if (b >= 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t <= len ? t : -1;
}

/**
 * Whether a shot travelling along unit (sdx, sdy) is blocked by a front shell facing unit (fx, fy)
 * whose half-width has cosine `cosHalf` (#80, kind.ts `shell`): the shot comes at the shell's face
 * within that half-width, -(f . s) >= cosHalf. Read from the shot's direction, not where it lands,
 * so the rule is the same whether a shot starts inside the bug or grazes its edge, and a policy can
 * apply it from where it stands. A zero facing (a bug not yet turned) blocks nothing.
 */
export function shellBlocks(fx: number, fy: number, sdx: number, sdy: number, cosHalf: number): boolean {
  return fx * fx + fy * fy > 0 && -(fx * sdx + fy * sdy) >= cosHalf;
}

/** The player credited for `s`: its owner, still in the life that fired it; else null. */
function creditFor(state: ArenaState, s: Shot): Player | null {
  for (const p of state.players) if (p.id === s.owner) return p.alive && p.lifeStartTick === s.life ? p : null;
  return null;
}

/**
 * Every shot flies one step. It hits the first live bug its path touches (the smallest entry
 * distance; ties: the lower index): the bug loses a hit point, the owner's streak grows, and a kill
 * scores its kind's points times the multiplier of the streak including this hit. A normal shot
 * ends on that hit. A review laser shot (#73) may hit `pierce` bugs: after a hit it looks on along
 * the same step's path for the next bug it has not hit yet, and ends on its last allowed hit. A
 * shot that reaches SHOT_RANGE or a wall ends there (`hit` false: it did not end on a bug, so the
 * browser draws no spark), resetting its owner's streak only if it hit nothing (a laser shot that
 * hit fewer bugs than its pierce keeps the streak). Shots never touch players. A shot whose owner left, or whose life ended, flies on and scores nothing.
 * A bug with a shell (#80, kind.ts `shell`) hit from within it (shellBlocks) loses nothing: the shot
 * ends there (`blocked`; a laser shot too, its earlier hits in this step standing, and it is not a
 * laser hit), and the owner's streak still grows, so aiming at a shell is not punished twice.
 */
export function stepShots(state: ArenaState): void {
  const ev = state.events;
  const bugs = state.bugs;
  let keep = 0;
  for (let i = 0; i < state.shots.length; i++) {
    const s = state.shots[i]!;
    const len = Math.min(SHOT_SPEED * DT, SHOT_RANGE - s.travelled);
    const owner = creditFor(state, s);
    let ended = false;
    while (s.pierce > 0) {
      let hitBug: Bug | null = null;
      let best = Infinity;
      for (const b of bugs) {
        // A bug this shot already hit is skipped: a shot starting inside it next step would hit it again.
        if (b.hp <= 0 || b.id === s.hitA || b.id === s.hitB) continue;
        const t = segmentHit(s.x, s.y, s.dx, s.dy, len, b.x, b.y, bugDef(b.kind).radius + SHOT_RADIUS);
        if (t >= 0 && t < best) {
          best = t;
          hitBug = b;
        }
      }
      if (!hitBug) break;
      const shell = bugDef(hitBug.kind).shell;
      if (shell && shellBlocks(hitBug.dx, hitBug.dy, s.dx, s.dy, shell.cosHalf)) {
        if (owner) {
          owner.streak++;
          ev.shellBlocks.push(owner.id);
        }
        s.hits++;
        s.pierce = 0;
        ev.shotsEnded.push({ id: s.id, hit: true, blocked: true, travelled: s.travelled + best });
        ended = true;
        break;
      }
      hitBug.hp--;
      if (owner) {
        owner.streak++;
        if (hitBug.hp <= 0) {
          const points = bugDef(hitBug.kind).points * mult(owner.streak);
          owner.score += points;
          owner.kills++;
          ev.kills.push({ bug: hitBug.id, by: owner.id, x: hitBug.x, y: hitBug.y, points, kind: hitBug.kind });
        }
      } else if (hitBug.hp <= 0) {
        ev.kills.push({ bug: hitBug.id, by: 0, x: hitBug.x, y: hitBug.y, points: 0, kind: hitBug.kind });
      }
      if (s.laser) ev.laserHits.push(s.owner);
      if (s.hits === 0) s.hitA = hitBug.id;
      else s.hitB = hitBug.id;
      s.hits++;
      s.pierce--;
      if (s.pierce === 0) {
        ev.shotsEnded.push({ id: s.id, hit: true, blocked: false, travelled: s.travelled + best });
        ended = true;
      }
    }
    if (ended) continue;
    s.x += s.dx * len;
    s.y += s.dy * len;
    s.travelled += len;
    if (s.travelled >= SHOT_RANGE - 1e-9 || s.x < 0 || s.x > WORLD_W || s.y < 0 || s.y > WORLD_H) {
      if (owner && s.hits === 0) owner.streak = 0;
      ev.shotsEnded.push({ id: s.id, hit: false, blocked: false, travelled: s.travelled });
      continue;
    }
    state.shots[keep++] = s;
  }
  state.shots.length = keep;
  // Bugs killed this step leave the arena.
  let alive = 0;
  for (let i = 0; i < bugs.length; i++) {
    const b = bugs[i]!;
    if (b.hp > 0) bugs[alive++] = b;
  }
  bugs.length = alive;
}
