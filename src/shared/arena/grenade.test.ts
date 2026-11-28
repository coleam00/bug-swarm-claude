// The grenade by stepping (#130): a press throws one along the aim, 320 units out; it goes off
// GRENADE_FLIGHT_S + GRENADE_BLINK_S later, 3 damage to every bug within 110 units (kills scoring
// the thrower at their multiplier, the streak untouched) and one hit to every player in reach who
// can be hit, the thrower included; a shield blocks it. Cooldown 6 s from the throw.
import { describe, expect, test } from "bun:test";
import { bugDef } from "./bugs/registry";
import { QUEEN_MARKER_TICKS, QUEEN_REWARD_EACH, QUEEN_REWARD_POOL } from "./queen";
import { QUEEN_EVERY_WAVES } from "./bugs/queen";
import { GLOB_POINTS } from "./bugs/glob";
import {
  DT,
  GRENADE_BLINK_S,
  GRENADE_COOLDOWN_S,
  GRENADE_COOLDOWN_TICKS,
  GRENADE_DAMAGE,
  GRENADE_FLIGHT_S,
  GRENADE_RADIUS,
  GRENADE_RANGE,
  HITS_PER_LIFE,
  RESPAWN_DELAY_S,
  WAVE_S,
  WORLD_W,
} from "./constants";
import { GRENADE_FUSE_TICKS, stepGrenades } from "./grenade";
import { SHIELD } from "./pickups/shield";
import { endLife, joinPlayer, type ArenaState, type Player } from "./sim";
import { arenaWith, downNow, hold, placeBug, stepQuiet } from "./testkit";

/** A grenade by `p` that goes off in the next step, at (x, y). */
function primed(a: ArenaState, p: Player, x: number, y: number): void {
  a.grenades.push({ owner: p.id, life: p.lifeStartTick, tick: a.tick, fromX: p.x, fromY: p.y, toX: x, toY: y, explodeTick: a.tick });
}

/** Players far from the blast stay untouchable, so only what a test does happens. */
function untouchable(...ps: Player[]): void {
  for (const p of ps) p.invulnTicks = 1e9;
}

describe("throwing", () => {
  test("the item's numbers: 320 units over 0.5 s, 0.5 s blinking, radius 110, 3 damage, 6 s cooldown", () => {
    expect([GRENADE_RANGE, GRENADE_FLIGHT_S, GRENADE_BLINK_S, GRENADE_RADIUS, GRENADE_DAMAGE, GRENADE_COOLDOWN_S]).toEqual([320, 0.5, 0.5, 110, 3, 6]);
    expect(GRENADE_FUSE_TICKS).toBe(20);
    expect(GRENADE_COOLDOWN_TICKS).toBe(120);
  });

  test("a press throws one along the aim, 320 units out, and reports it; holding it throws once", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { aim: Math.PI / 2, grenade: true });
    stepQuiet(a);
    expect(a.grenades).toHaveLength(1);
    const g = a.grenades[0]!;
    expect(a.events.grenadesThrown).toEqual([g]);
    expect(g.owner).toBe(p.id);
    expect([g.fromX, g.fromY]).toEqual([1200, 1200]);
    expect(g.toX).toBeCloseTo(1200, 9);
    expect(g.toY).toBeCloseTo(1200 + GRENADE_RANGE, 9);
    expect(g.explodeTick).toBe(g.tick + GRENADE_FUSE_TICKS);
    expect(p.grenadeCooldown).toBe(GRENADE_COOLDOWN_TICKS);
    stepQuiet(a, 5);
    expect(a.grenades).toHaveLength(1);
    expect(a.events.grenadesThrown).toEqual([]);
  });

  test("a landing point past a wall is kept inside it", () => {
    const { a, ps } = arenaWith([WORLD_W - 100, 1200]);
    hold(ps[0]!, { aim: 0, grenade: true });
    stepQuiet(a);
    expect(a.grenades[0]!.toX).toBe(WORLD_W);
  });

  test("a press inside the 6 s cooldown is dropped, not kept; the first press after it throws", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    untouchable(p);
    const press = () => {
      hold(p, { grenade: true });
      stepQuiet(a);
      const n = a.events.grenadesThrown.length;
      hold(p, {});
      stepQuiet(a);
      return n;
    };
    expect(press()).toBe(1);
    // Two steps gone; press until one tick before the cooldown has run out.
    for (let i = 2; i < GRENADE_COOLDOWN_TICKS - 1; i += 2) expect(press()).toBe(0);
    expect(p.grenadeCooldown).toBe(1);
    expect(press()).toBe(1);
  });

  test("the thrower goes off on its own step: nothing while it flies and blinks, the blast 20 steps after the throw", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { grenade: true });
    stepQuiet(a);
    const thrown = a.tick - 1;
    hold(p, {});
    stepQuiet(a, GRENADE_FUSE_TICKS - 1);
    expect(a.grenades).toHaveLength(1);
    expect(a.tick).toBe(thrown + GRENADE_FUSE_TICKS);
    stepQuiet(a);
    expect(a.grenades).toEqual([]);
  });

  test("a downed or out player cannot throw; the press that respawns you, or one held through a revive, throws nothing", () => {
    const { a, ps } = arenaWith([1200, 1200], [600, 600]);
    const [p, q] = ps as [Player, Player];
    untouchable(q);
    downNow(a, p);
    expect(p.down).toBe(true);
    hold(p, { grenade: true });
    stepQuiet(a, 3);
    expect(a.grenades).toEqual([]);
    // Revived by hand while still holding: no press on the way up.
    p.down = false;
    p.hits = 0;
    p.invulnTicks = 1e9;
    stepQuiet(a, 3);
    expect(a.grenades).toEqual([]);
    // Out, the respawn held with the grenade: back in a life, nothing thrown.
    endLife(a, p);
    hold(p, { grenade: true, dash: true });
    stepQuiet(a, Math.round(RESPAWN_DELAY_S / DT) + 2);
    expect(p.alive).toBe(true);
    expect(a.grenades).toEqual([]);
    // Let go and pressed again: it throws.
    hold(p, {});
    stepQuiet(a);
    hold(p, { grenade: true });
    stepQuiet(a);
    expect(a.grenades).toHaveLength(1);
  });
});

describe("the blast on bugs", () => {
  test("3 damage to every bug within 110 units, a beetle's shell no shield; kills score the kind's points at the thrower's multiplier, the streak untouched", () => {
    const { a, ps } = arenaWith([200, 200]);
    const p = ps[0]!;
    p.streak = 10; // x2
    const at = 1800;
    const crawler = placeBug(a, at + 50, at);
    const dasher = placeBug(a, at, at + 109, "dasher");
    const spitter = placeBug(a, at - 70, at - 70, "spitter");
    const glob = placeBug(a, at, at, "glob");
    const beetle = placeBug(a, at + 30, at, "beetle");
    // Facing the blast square on: a shot from there would be blocked.
    beetle.dx = -1;
    beetle.dy = 0;
    const edge = placeBug(a, at - GRENADE_RADIUS, at);
    const outside = placeBug(a, at, at - GRENADE_RADIUS - 1);
    primed(a, p, at, at);
    stepGrenades(a);
    expect([crawler.hp, dasher.hp, spitter.hp, glob.hp, edge.hp]).toEqual([-2, -1, 0, -2, -2]);
    expect(beetle.hp).toBe(bugDef("beetle").hp - GRENADE_DAMAGE);
    expect(outside.hp).toBe(bugDef("crawler").hp);
    const kills = a.events.kills.map((k) => [k.bug, k.by, k.points]);
    expect(kills).toEqual([
      [crawler.id, p.id, 20],
      [dasher.id, p.id, 50],
      [spitter.id, p.id, 60],
      [glob.id, p.id, GLOB_POINTS * 2],
      [edge.id, p.id, 20],
    ]);
    expect(p.score).toBe(20 + 50 + 60 + GLOB_POINTS * 2 + 20);
    expect(p.kills).toBe(5);
    expect(p.streak).toBe(10);
    // The dead leave in the same step.
    expect(a.bugs.map((b) => b.id).sort()).toEqual([beetle.id, outside.id].sort());
    expect(a.grenades).toEqual([]);
  });

  test("a thrower whose life ended scores nothing: the kill row's by is 0", () => {
    const { a, ps } = arenaWith([200, 200]);
    const p = ps[0]!;
    const bug = placeBug(a, 1800, 1800);
    primed(a, p, 1800, 1800);
    endLife(a, p);
    stepGrenades(a);
    expect(bug.hp).toBeLessThanOrEqual(0);
    expect(a.events.kills.map((k) => [k.by, k.points])).toEqual([[0, 0]]);
    expect(p.score).toBe(0);
  });

  test("its kills drop pickups and leave in the step, through stepArena", () => {
    const { a, ps } = arenaWith([200, 200]);
    untouchable(ps[0]!);
    const bug = placeBug(a, 1800, 1800);
    primed(a, ps[0]!, 1800, 1800);
    stepQuiet(a);
    expect(a.events.kills.map((k) => k.bug)).toEqual([bug.id]);
    expect(a.bugs).toEqual([]);
  });

  test("the hive queen takes 3, credited to the thrower, and a blast kill pays her reward in the same step", () => {
    const { a, ps } = arenaWith([200, 200]);
    const p = ps[0]!;
    untouchable(p);
    a.tick = Math.round(((QUEEN_EVERY_WAVES - 1) * WAVE_S) / DT);
    stepQuiet(a, 1 + QUEEN_MARKER_TICKS);
    const q = a.bugs.find((b) => b.kind === "queen")!;
    p.x = q.x + 400;
    p.y = q.y;
    const hp = q.hp;
    primed(a, p, q.x, q.y);
    stepQuiet(a);
    expect(hp - q.hp).toBe(GRENADE_DAMAGE);
    expect(p.queenDmg).toBe(GRENADE_DAMAGE);
    q.hp = GRENADE_DAMAGE;
    primed(a, p, q.x, q.y);
    stepQuiet(a);
    expect(a.events.queenDown).toEqual({ top: p.id, paid: [[p.id, QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]] });
  });
});

describe("the blast on players (owner ruling: the grenade's blast is the one friendly fire)", () => {
  test("one hit each for the thrower, a teammate, the other team and a fill bot in reach; none for one outside it", () => {
    const { a, ps } = arenaWith([1200, 1200], [1260, 1200], [1200, 1290]);
    const [thrower, foe, mate] = ps as [Player, Player, Player];
    expect([thrower.team, foe.team, mate.team]).toEqual(["tabs", "spaces", "tabs"]);
    const bot = joinPlayer(a, "bot", "spaces", true);
    bot.x = 1150;
    bot.y = 1150;
    bot.protectTicks = 0;
    bot.effect.fill(0);
    const far = joinPlayer(a, "far", "tabs");
    far.x = 1200 + GRENADE_RADIUS + 1;
    far.y = 1200;
    far.protectTicks = 0;
    far.effect.fill(0);
    const rng = a.rng.state;
    primed(a, thrower, 1200, 1200);
    stepGrenades(a);
    expect([thrower.hits, foe.hits, mate.hits, bot.hits, far.hits]).toEqual([1, 1, 1, 1, 0]);
    expect(a.events.hitsTaken).toEqual([thrower.id, foe.id, mate.id, bot.id]);
    // A blast is no bug touching anyone.
    expect(a.events.touches).toEqual([]);
    expect(a.rng.state).toBe(rng);
  });

  test("no hit for a downed, dashing, spawn-protected or untouchable player; a test shield blocks it and is spent", () => {
    const { a, ps } = arenaWith([1200, 1200], [1220, 1200], [1240, 1200], [1260, 1200], [1200, 1240], [1180, 1200]);
    const [downed, dashing, protectedP, hitJustNow, shielded, thrower] = ps as [Player, Player, Player, Player, Player, Player];
    untouchable(thrower);
    downed.down = true;
    downed.hits = HITS_PER_LIFE;
    dashing.dashTicks = 2;
    protectedP.protectTicks = 10;
    hitJustNow.invulnTicks = 5;
    shielded.effect[SHIELD] = 100;
    primed(a, thrower, 1200, 1200);
    stepGrenades(a);
    expect([downed.hits, dashing.hits, protectedP.hits, hitJustNow.hits, shielded.hits]).toEqual([HITS_PER_LIFE, 0, 0, 0, 0]);
    expect(a.events.blocks).toEqual([shielded.id]);
    expect(shielded.effect[SHIELD]).toBe(0);
    expect(a.events.hitsTaken).toEqual([]);
  });

  test("a third hit puts the player down", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.hits = HITS_PER_LIFE - 1;
    primed(a, p, 1200, 1200);
    stepGrenades(a);
    expect(p.down).toBe(true);
    expect(a.events.downs).toEqual([p.id]);
  });
});
