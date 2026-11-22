// The hive queen's arena rules (#85), by stepping: her arrival (when, where, the marker), at most
// one, her toughness, her goal, the damage ledger and the reward split. Her own behaviour (drift,
// brood, ring, contact) is in bugs/queen.test.ts.
import { describe, expect, test } from "bun:test";
import { BROOD_TICKS, QUEEN_EVERY_WAVES } from "./bugs/queen";
import { DT, PICKUP_IDS, WAVE_S, WORLD_H, WORLD_W } from "./constants";
import { BOMB_DAMAGE } from "./pickups/bomb";
import {
  GROUP_R,
  QUEEN_GRID_STEP,
  QUEEN_HP_BASE,
  QUEEN_HP_BOT,
  QUEEN_HP_PERSON,
  QUEEN_MARKER_TICKS,
  QUEEN_PLAYER_CLEAR,
  QUEEN_REWARD_EACH,
  QUEEN_REWARD_POOL,
  QUEEN_WALL_CLEAR,
  groupGoal,
  queenRewards,
  queenSpot,
  queenWaveStarts,
} from "./queen";
import { createRng, nextRandom } from "./rng";
import { createArena, endLife, joinPlayer, type ArenaState, type Bug, type Player } from "./sim";
import { arenaWith, bleedNow, downNow, hold, placePickup, stepQuiet } from "./testkit";

/** The first tick of wave `w`. */
const waveTick = (w: number) => Math.round(((w - 1) * WAVE_S) / DT);
const W5 = waveTick(QUEEN_EVERY_WAVES);

/** Runs `a` to the first tick of wave 5 and through her marker; returns her bug. */
function arrive(a: ArenaState): Bug {
  a.tick = W5;
  stepQuiet(a, 1 + QUEEN_MARKER_TICKS);
  const q = a.bugs.find((b) => b.kind === "queen");
  if (!q) throw new Error("no queen");
  return q;
}

/** Players stand far from her and from bugs, untouchable, so only what a test does happens. */
function shield(ps: Player[]): void {
  for (const p of ps) p.invulnTicks = 1e9;
}

describe("arrival", () => {
  test("her marker starts on the first tick of every fifth wave, and on no other", () => {
    for (let w = 1; w <= 15; w++) {
      expect(queenWaveStarts(waveTick(w))).toBe(w % QUEEN_EVERY_WAVES === 0 && w > 1);
      expect(queenWaveStarts(waveTick(w) + 1)).toBe(false);
    }
    const { a } = arenaWith([200, 200]);
    for (let w = 1; w < QUEEN_EVERY_WAVES; w++) {
      a.tick = waveTick(w);
      stepQuiet(a);
      expect(a.queen.stage).toBe(0);
    }
    a.tick = W5 - 1;
    stepQuiet(a);
    expect(a.queen.stage).toBe(0);
    stepQuiet(a);
    expect([a.queen.stage, a.queen.ticksLeft]).toEqual([1, QUEEN_MARKER_TICKS]);
  });

  test("nothing is there for the marker's 2 s, so a player parked on the spot is never hit; she appears on its last tick", () => {
    const { a, ps } = arenaWith([200, 200]);
    a.tick = W5;
    stepQuiet(a);
    const p = ps[0]!;
    p.x = a.queen.x;
    p.y = a.queen.y;
    for (let t = 1; t < QUEEN_MARKER_TICKS; t++) {
      stepQuiet(a);
      expect(a.bugs).toHaveLength(0);
      expect(a.queen.stage).toBe(1);
    }
    expect(p.hits).toBe(0);
    stepQuiet(a);
    expect(a.queen.stage).toBe(2);
    expect(a.bugs.map((b) => b.kind)).toEqual(["queen"]);
    expect(a.tick).toBe(W5 + QUEEN_MARKER_TICKS + 1);
  });

  test("her spot is on the grid, inside the wall clearance, and at least 600 from every player in a life (downed ones too)", () => {
    for (let seed = 0; seed < 40; seed++) {
      const r = createRng(seed);
      const a = createArena(seed);
      for (let i = 0; i < 6; i++) {
        const p = joinPlayer(a, `p${i}`, "tabs");
        p.x = 100 + nextRandom(r) * 2200;
        p.y = 100 + nextRandom(r) * 2200;
        if (i === 1) p.down = true;
      }
      const out = { x: 0, y: 0 };
      queenSpot(a, out);
      expect(out.x).toBeGreaterThanOrEqual(QUEEN_WALL_CLEAR);
      expect(out.x).toBeLessThanOrEqual(WORLD_W - QUEEN_WALL_CLEAR);
      expect(out.y).toBeGreaterThanOrEqual(QUEEN_WALL_CLEAR);
      expect(out.y).toBeLessThanOrEqual(WORLD_H - QUEEN_WALL_CLEAR);
      expect((out.x - QUEEN_WALL_CLEAR) % QUEEN_GRID_STEP).toBe(0);
      for (const p of a.players) expect(Math.hypot(p.x - out.x, p.y - out.y)).toBeGreaterThanOrEqual(QUEEN_PLAYER_CLEAR);
    }
  });

  test("an out player does not keep her away", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    endLife(a, ps[0]!);
    let near = 0;
    for (let i = 0; i < 100; i++) {
      const out = { x: 0, y: 0 };
      queenSpot(a, out);
      if (Math.hypot(out.x - 1200, out.y - 1200) < QUEEN_PLAYER_CLEAR) near++;
    }
    // About a third of the grid is within 600 of the middle.
    expect(near).toBeGreaterThan(10);
  });

  test("with players spread so no spot is 600 clear, the spot farthest from its nearest player, the same every time, with no draw", () => {
    const { a } = arenaWith(...[300, 900, 1500, 2100].flatMap((x) => [300, 900, 1500, 2100].map((y): [number, number] => [x, y])));
    const before = a.queenRng.state;
    const one = { x: 0, y: 0 };
    queenSpot(a, one);
    expect(a.queenRng.state).toBe(before);
    // The lattice's gaps: a spot 300 from its nearest four (424 on the diagonal), the first in grid order.
    expect(one).toEqual({ x: 600, y: 600 });
  });

  test("her arrival never draws from the arena's own generator: spawns and spread replay as without her", () => {
    const { a } = arenaWith([200, 200]);
    a.tick = W5;
    const rng = a.rng.state;
    stepQuiet(a, 1 + QUEEN_MARKER_TICKS);
    expect(a.queen.stage).toBe(2);
    expect(a.rng.state).toBe(rng);
  });

  test("a join or respawn never lands on her marker", () => {
    for (let seed = 0; seed < 20; seed++) {
      const a = createArena(seed);
      a.tick = W5;
      stepQuiet(a);
      const p = joinPlayer(a, "late", "tabs");
      expect(Math.hypot(p.x - a.queen.x, p.y - a.queen.y)).toBeGreaterThan(500);
    }
  });
});

describe("at most one", () => {
  test("a queen still alive at wave 10 means no second marker; once she is dead, wave 15 brings the next", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const q = arrive(a);
    a.tick = waveTick(2 * QUEEN_EVERY_WAVES);
    stepQuiet(a);
    expect(a.queen.stage).toBe(2);
    expect(a.bugs.filter((b) => b.kind === "queen")).toHaveLength(1);
    // A kill clears the stage; the next fifth wave brings a new one.
    q.hp = 1;
    killWithShot(a, ps[0]!, q);
    expect(a.queen.stage).toBe(0);
    a.tick = waveTick(3 * QUEEN_EVERY_WAVES);
    stepQuiet(a, 1 + QUEEN_MARKER_TICKS);
    expect(a.queen.stage).toBe(2);
    expect(a.bugs.filter((b) => b.kind === "queen")).toHaveLength(1);
  });
});

describe("toughness", () => {
  test("a base plus per person in the arena when she arrives, half for a fill bot, out players included", () => {
    const one = arenaWith([200, 200]);
    expect(arrive(one.a).hp).toBe(QUEEN_HP_BASE + QUEEN_HP_PERSON);

    const { a, ps } = arenaWith([200, 200], [250, 200], [300, 200], [350, 200]);
    joinPlayer(a, "bot Ada", "tabs", true);
    joinPlayer(a, "bot Linus", "spaces", true);
    endLife(a, ps[3]!);
    const q = arrive(a);
    expect(q.hp).toBe(QUEEN_HP_BASE + 4 * QUEEN_HP_PERSON + 2 * QUEEN_HP_BOT);
    expect(a.queen.maxHp).toBe(q.hp);
  });
});

describe("goal", () => {
  test("the middle of the largest group of players who are up, not a lone player nearer to her", () => {
    const { ps } = arenaWith([400, 400], [1800, 1800], [1850, 1800], [1800, 1850]);
    const out = { x: 0, y: 0 };
    expect(groupGoal(ps, 500, 500, out)).toBe(true);
    expect(out.x).toBeCloseTo(1816.67, 1);
    expect(out.y).toBeCloseTo(1816.67, 1);
  });

  test("downed and out players are no group; with nobody up there is no goal", () => {
    const { a, ps } = arenaWith([400, 400], [1800, 1800], [1850, 1800]);
    ps[1]!.down = true;
    endLife(a, ps[2]!);
    const out = { x: 0, y: 0 };
    expect(groupGoal(ps, 1800, 1800, out)).toBe(true);
    expect(out).toEqual({ x: 400, y: 400 });
    ps[0]!.down = true;
    expect(groupGoal(ps, 1800, 1800, out)).toBe(false);
  });

  test("a tie goes to the group nearer to her; a group is everyone up within GROUP_R", () => {
    // Two pairs, each exactly GROUP_R apart (a tie at 2), the farther pair listed first.
    const { ps } = arenaWith([2000, 2000], [2000 + GROUP_R, 2000], [400, 400], [400 + GROUP_R, 400]);
    const out = { x: 0, y: 0 };
    groupGoal(ps, 500, 500, out);
    expect(out).toEqual({ x: 400 + GROUP_R / 2, y: 400 });
    // One unit past GROUP_R is not a group: the nearer pair, still together, wins 2 against 1.
    const apart = arenaWith([400, 400], [400 + GROUP_R, 400], [2000, 2000], [2000 + GROUP_R + 1, 2000]);
    groupGoal(apart.ps, 2100, 2000, out);
    expect(out).toEqual({ x: 400 + GROUP_R / 2, y: 400 });
  });

  test("stepping, she drifts toward a group of three over a lone player", () => {
    const { a, ps } = arenaWith([200, 1200], [2200, 1200], [2200, 1250], [2150, 1200]);
    shield(ps);
    const q = arrive(a);
    const x0 = q.x;
    const toGroup = Math.hypot(2183 - q.x, 1217 - q.y);
    stepQuiet(a, 20);
    expect(Math.hypot(2183 - q.x, 1217 - q.y)).toBeLessThan(toGroup);
    expect(q.gx).toBeCloseTo((2200 + 2200 + 2150) / 3, 6);
    if (x0 < 2100) expect(q.x).toBeGreaterThan(x0);
  });
});

/** Fires one shot from `p` at bug `b` (placed in line) until it lands; returns the step's kill rows. */
function killWithShot(a: ArenaState, p: Player, b: Bug): void {
  p.x = b.x - 120;
  p.y = b.y;
  for (let i = 0; i < 6 && b.hp > 0; i++) {
    hold(p, { aim: 0, fire: i === 0 });
    stepQuiet(a);
  }
  hold(p, {});
}

describe("the reward (pure)", () => {
  const share = (d: number, sum: number) => Math.floor((QUEEN_REWARD_POOL * d) / sum);

  test("one contributor takes everything: 75 plus the whole pool", () => {
    const out: number[] = [];
    queenRewards([37], out);
    expect(out).toEqual([QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]);
  });

  test("two split the pool by damage, rounded down, never past it", () => {
    const out: number[] = [];
    queenRewards([2, 1], out);
    expect(out).toEqual([QUEEN_REWARD_EACH + 400, QUEEN_REWARD_EACH + 200]);
    queenRewards([1, 1, 1], out);
    expect(out).toEqual([275, 275, 275]);
    queenRewards([7, 0, 3], out);
    expect(out).toEqual([QUEEN_REWARD_EACH + share(7, 10), 0, QUEEN_REWARD_EACH + share(3, 10)]);
  });

  test("twenty with uneven damage: each at most 75 plus its share, the shares at most 600, the total at most 75n + 600", () => {
    for (let seed = 0; seed < 50; seed++) {
      const r = createRng(seed);
      const dmg = Array.from({ length: 20 }, () => 1 + Math.floor(nextRandom(r) ** 3 * 200));
      const sum = dmg.reduce((s, d) => s + d, 0);
      const out: number[] = [];
      queenRewards(dmg, out);
      let shares = 0;
      for (let i = 0; i < 20; i++) {
        expect(out[i]!).toBeLessThanOrEqual(QUEEN_REWARD_EACH + (QUEEN_REWARD_POOL * dmg[i]!) / sum);
        expect(out[i]!).toBeGreaterThanOrEqual(QUEEN_REWARD_EACH);
        shares += out[i]! - QUEEN_REWARD_EACH;
      }
      expect(shares).toBeLessThanOrEqual(QUEEN_REWARD_POOL);
      expect(shares).toBeGreaterThan(QUEEN_REWARD_POOL - 20);
      expect(out.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(QUEEN_REWARD_EACH * 20 + QUEEN_REWARD_POOL);
    }
  });

  test("nobody paid: nothing", () => {
    const out: number[] = [9];
    queenRewards([], out);
    expect(out).toEqual([]);
  });
});

describe("the reward (stepping)", () => {
  test("a shot kill pays every contributor in the same step, by damage, and names the top dealer", () => {
    const { a, ps } = arenaWith([200, 200], [200, 400]);
    shield(ps);
    const q = arrive(a);
    ps[0]!.queenDmg = 30;
    ps[1]!.queenDmg = 10;
    q.hp = 1;
    const scores = ps.map((p) => p.score);
    killWithShot(a, ps[1]!, q);
    const down = a.events.queenDown!;
    // ps[1]'s killing shot added 1 to its damage: 30 and 11.
    const out: number[] = [];
    queenRewards([30, 11], out);
    expect(down).toEqual({ top: ps[0]!.id, paid: [[ps[0]!.id, out[0]!], [ps[1]!.id, out[1]!]] });
    expect(ps[0]!.score - scores[0]!).toBe(out[0]!);
    // The killer's kill row scores no kind points: the reward is the score.
    expect(ps[1]!.score - scores[1]!).toBe(out[1]!);
    expect(a.queen.stage).toBe(0);
    expect(a.bugs.some((b) => b.kind === "queen")).toBe(false);
  });

  test("a shot credits its life one hit point a hit", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const q = arrive(a);
    const hp = q.hp;
    killWithShot(a, ps[0]!, q);
    expect(ps[0]!.queenDmg).toBe(1);
    expect(q.hp).toBe(hp - 1);
  });

  test("a CI drone's shots (#84) credit the life holding it, as the gun's do", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const q = arrive(a);
    const p = ps[0]!;
    p.x = q.x - 200;
    p.y = q.y;
    p.effect[PICKUP_IDS.indexOf("drone")] = 100;
    const hp = q.hp;
    for (let i = 0; i < 40; i++) stepQuiet(a);
    expect(hp - q.hp).toBeGreaterThan(0);
    expect(p.queenDmg).toBe(hp - q.hp);
  });

  test("a bomb kill pays in the same step, its damage credited to the taker", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const q = arrive(a);
    q.hp = BOMB_DAMAGE - 1;
    const p = ps[0]!;
    p.x = q.x + 100;
    p.y = q.y;
    placePickup(a, p.x, p.y, "bomb");
    stepQuiet(a);
    expect(p.queenDmg).toBe(BOMB_DAMAGE - 1);
    expect(a.events.queenDown).toEqual({ top: p.id, paid: [[p.id, QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]] });
  });

  test("a downed contributor is paid; one whose life ended before the kill gets nothing, even back in a new life", () => {
    const { a, ps } = arenaWith([200, 200], [200, 600], [600, 200]);
    shield(ps);
    const q = arrive(a);
    const [killer, downed, bled] = ps as [Player, Player, Player];
    downed.queenDmg = 20;
    bled.queenDmg = 50;
    downed.invulnTicks = 0;
    downNow(a, downed);
    bled.invulnTicks = 0;
    downNow(a, bled);
    bleedNow(a, bled);
    expect(bled.alive).toBe(false);
    hold(bled, { dash: true });
    stepQuiet(a, 20);
    expect(bled.alive).toBe(true);
    expect(bled.queenDmg).toBe(0);
    q.hp = 1;
    killWithShot(a, killer, q);
    const out: number[] = [];
    queenRewards([1, 20], out);
    expect(a.events.queenDown!.paid).toEqual([
      [killer.id, out[0]!],
      [downed.id, out[1]!],
    ]);
    expect(downed.down).toBe(true);
  });

  test("a contributor whose life ended before the kill, still out, gets nothing", () => {
    const { a, ps } = arenaWith([200, 200], [200, 600]);
    shield(ps);
    const q = arrive(a);
    const [killer, out] = ps as [Player, Player];
    out.queenDmg = 50;
    endLife(a, out);
    // No respawn: its damage stays on it, so only the in-a-life rule keeps it unpaid.
    expect([out.alive, out.queenDmg]).toEqual([false, 50]);
    q.hp = 1;
    killWithShot(a, killer, q);
    expect(a.events.queenDown!.paid).toEqual([[killer.id, QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]]);
  });

  test("a fill bot takes no reward and no share, but can be the top dealer", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const bot = joinPlayer(a, "bot Ada", "tabs", true);
    bot.x = 2200;
    bot.y = 2200;
    bot.invulnTicks = 1e9;
    const q = arrive(a);
    bot.queenDmg = 90;
    q.hp = 1;
    killWithShot(a, ps[0]!, q);
    expect(a.events.queenDown).toEqual({ top: bot.id, paid: [[ps[0]!.id, QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]] });
  });

  test("a kill by a shot whose life is over pays everyone else and still clears her", () => {
    const { a, ps } = arenaWith([200, 200], [200, 600]);
    shield(ps);
    const q = arrive(a);
    ps[1]!.queenDmg = 5;
    q.hp = 1;
    const shooter = ps[0]!;
    shooter.x = q.x - 300;
    shooter.y = q.y;
    hold(shooter, { aim: 0, fire: true });
    stepQuiet(a);
    hold(shooter, {});
    endLife(a, shooter);
    for (let i = 0; i < 10 && a.queen.stage === 2; i++) stepQuiet(a);
    expect(a.queen.stage).toBe(0);
    expect(a.events.queenDown).toEqual({ top: ps[1]!.id, paid: [[ps[1]!.id, QUEEN_REWARD_EACH + QUEEN_REWARD_POOL]] });
    expect(a.events.kills).toEqual([expect.objectContaining({ bug: q.id, by: 0, points: 0 })]);
  });

  test("her arrival zeroes everyone's damage", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    ps[0]!.queenDmg = 99;
    arrive(a);
    expect(ps[0]!.queenDmg).toBe(0);
  });
});

describe("contact with her", () => {
  test("costs a hit and she stays; a test shield blocks her as any contact", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    const q = arrive(a);
    const p = ps[0]!;
    p.invulnTicks = 0;
    p.x = q.x + 30;
    p.y = q.y;
    stepQuiet(a);
    expect(p.hits).toBe(1);
    expect(a.bugs).toContain(q);
    // A shield spends instead of a hit.
    p.invulnTicks = 0;
    p.effect[0] = 100;
    stepQuiet(a);
    expect(p.hits).toBe(1);
    expect(a.events.blocks).toEqual([p.id]);
    expect(a.bugs).toContain(q);
  });

  test("her first brood comes BROOD_TICKS after she arrives", () => {
    const { a, ps } = arenaWith([200, 200]);
    shield(ps);
    arrive(a);
    stepQuiet(a, BROOD_TICKS - 2);
    expect(a.bugs.filter((b) => b.kind === "crawler")).toHaveLength(0);
    stepQuiet(a);
    expect(a.bugs.filter((b) => b.kind === "crawler").length).toBeGreaterThan(0);
  });
});
