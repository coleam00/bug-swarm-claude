// Down, revive and bleed-out (#59), stepped on the pure arena with fixed inputs.
import { describe, expect, test } from "bun:test";
import { DOWN_TICKS, DT, HITS_PER_LIFE, RESPAWN_DELAY_S, REVIVE_POINTS, REVIVE_PROTECT_TICKS, REVIVE_TICKS } from "./constants";
import { leavePlayer, stepArena, type ArenaState, type Player } from "./sim";
import { arenaWith, bleedNow, downNow, hold, placeBug, stepQuiet } from "./testkit";

/** Steps `n` quiet ticks, collecting every revive event. */
function revivesOver(a: ArenaState, n: number) {
  const seen: { id: number; by: number; points: number }[] = [];
  for (let i = 0; i < n; i++) {
    stepQuiet(a);
    seen.push(...a.events.revives);
  }
  return seen;
}

/** Puts `h` at `d` units to the right of `p`. */
function beside(p: Player, h: Player, d: number): void {
  h.x = p.x + d;
  h.y = p.y;
}

describe("going down", () => {
  test("the third hit puts you down: still in the life, stopped, and a held move, fire or dash does nothing", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    hold(p, { mx: 1 });
    stepQuiet(a, 5);
    expect(p.vx).toBeGreaterThan(0);
    p.hits = HITS_PER_LIFE - 1;
    placeBug(a, p.x + 5, p.y);
    stepQuiet(a);
    expect([p.alive, p.down, p.vx, p.vy]).toEqual([true, true, 0, 0]);
    expect(a.events.downs).toEqual([p.id]);
    expect(a.events.livesEnded).toEqual([]);
    expect(p.downTick).toBe(a.tick - 1);
    const at = [p.x, p.y];
    hold(p, { mx: 1, my: 1, aim: 2, fire: true, dash: true });
    for (let i = 0; i < 20; i++) {
      stepQuiet(a);
      expect([p.x, p.y]).toEqual(at);
      expect(a.events.shotsFired).toEqual([]);
      expect(a.events.downs).toEqual([]);
    }
    expect([p.alive, p.down, p.aim]).toEqual([true, true, 0]);
  });

  test("bugs chase a player who is up over a nearer downed one, and stand when only the downed are left", () => {
    const { a, ps } = arenaWith([1200, 1200], [1600, 1200]);
    const [down, up] = [ps[0]!, ps[1]!];
    downNow(a, down);
    const b = placeBug(a, 1100, 1200);
    stepQuiet(a);
    expect(b.target).toBe(up.id);
    expect(b.x).toBeGreaterThan(1100);
    // A bug right on the downed player passes over it: no hit, and it stays in play.
    const on = placeBug(a, down.x, down.y);
    stepQuiet(a);
    expect(a.events.hitsTaken).toEqual([]);
    expect(a.bugs).toContain(on);
    leavePlayer(a, up.id);
    stepQuiet(a);
    expect(a.bugs.map((g) => [g.target, g.vx, g.vy])).toEqual([
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });

  test("a downed player's spawn budget waits", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    downNow(a, p);
    p.budget = 0.5;
    for (let i = 0; i < 40; i++) stepArena(a);
    expect(p.budget).toBe(0.5);
    expect(a.bugs).toEqual([]); // the bug that downed it was spent on the hit, and none spawned
  });
});

describe("bleeding out", () => {
  test("the life ends on exactly the DOWN_S-th step after going down, and a dash then respawns as before", () => {
    const { a, ps } = arenaWith([1200, 1200]);
    const p = ps[0]!;
    p.score = 90;
    p.kills = 7;
    downNow(a, p);
    const downAt = p.downTick;
    while (a.tick - downAt < DOWN_TICKS) {
      stepQuiet(a);
      expect(a.events.livesEnded).toEqual([]);
      expect(p.down).toBe(true);
    }
    stepQuiet(a);
    expect(a.events.livesEnded).toEqual([{ id: p.id, score: 90, kills: 7, ticks: downAt + DOWN_TICKS }]);
    expect([p.alive, p.down]).toEqual([false, false]);
    const outAt = a.tick - 1;
    hold(p, { dash: true });
    while (a.tick - outAt < Math.round(RESPAWN_DELAY_S / DT)) {
      stepQuiet(a);
      expect(p.alive).toBe(false);
    }
    stepQuiet(a);
    expect([p.alive, p.down, p.hits]).toEqual([true, false, 0]);
  });
});

describe("reviving", () => {
  test("a player in range for REVIVE_S revives you with one hit left and protection, and scores REVIVE_POINTS", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [p, h] = [ps[0]!, ps[1]!];
    downNow(a, p);
    beside(p, h, 50);
    expect(revivesOver(a, REVIVE_TICKS - 1)).toEqual([]);
    expect([p.down, p.reviver, p.reviveTicks]).toEqual([true, h.id, REVIVE_TICKS - 1]);
    stepQuiet(a);
    expect(a.events.revives).toEqual([{ id: p.id, by: h.id, points: REVIVE_POINTS }]);
    expect([p.down, p.alive, p.hits, p.invulnTicks, p.reviver, p.reviveTicks]).toEqual([false, true, HITS_PER_LIFE - 1, REVIVE_PROTECT_TICKS, 0, 0]);
    expect(h.score).toBe(REVIVE_POINTS);
    // The item's numbers: 2 s (40 steps) in range, 50 points, 1.5 s (30 steps) of protection.
    expect(REVIVE_TICKS).toBe(40);
    expect(h.score).toBe(50);
    expect(p.invulnTicks).toBe(30);
    // Back up: it moves again.
    hold(p, { mx: 1 });
    stepQuiet(a);
    expect(p.vx).toBeGreaterThan(0);
  });

  test("the range is inclusive: 60 units counts, 60.5 does not", () => {
    for (const [d, revived] of [
      [60, true],
      [60.5, false],
    ] as const) {
      const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
      const [p, h] = [ps[0]!, ps[1]!];
      downNow(a, p);
      beside(p, h, d);
      expect(revivesOver(a, REVIVE_TICKS).length).toBe(revived ? 1 : 0);
    }
  });

  test("walking out of range cancels: progress resets and coming back needs the full REVIVE_S", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [p, h] = [ps[0]!, ps[1]!];
    downNow(a, p);
    beside(p, h, 40);
    revivesOver(a, 20);
    expect([p.reviver, p.reviveTicks]).toEqual([h.id, 20]);
    beside(p, h, 200);
    stepQuiet(a);
    expect([p.reviver, p.reviveTicks]).toEqual([0, 0]);
    beside(p, h, 40);
    expect(revivesOver(a, REVIVE_TICKS - 1)).toEqual([]);
    expect(revivesOver(a, 1)).toEqual([{ id: p.id, by: h.id, points: REVIVE_POINTS }]);
  });

  test("anyone revives, across teams: tabs brings back spaces", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [tabs, spaces] = [ps[0]!, ps[1]!];
    expect([tabs.team, spaces.team]).toEqual(["tabs", "spaces"]);
    downNow(a, spaces);
    beside(spaces, tabs, 30);
    expect(revivesOver(a, REVIVE_TICKS)).toEqual([{ id: spaces.id, by: tabs.id, points: REVIVE_POINTS }]);
    expect(tabs.score).toBe(REVIVE_POINTS);
  });

  test("two revivers at once: one revive, and only the holder (the nearest) scores", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400], [1600, 1600]);
    const [p, far, near] = [ps[0]!, ps[1]!, ps[2]!];
    downNow(a, p);
    beside(p, far, 50);
    beside(p, near, -30);
    expect(revivesOver(a, REVIVE_TICKS + 20)).toEqual([{ id: p.id, by: near.id, points: REVIVE_POINTS }]);
    expect([near.score, far.score]).toEqual([REVIVE_POINTS, 0]);
  });

  test("two revivers the same distance away: the earlier in the list holds", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400], [1600, 1600]);
    const [p, first, second] = [ps[0]!, ps[1]!, ps[2]!];
    downNow(a, p);
    beside(p, second, 40);
    beside(p, first, -40);
    expect(revivesOver(a, REVIVE_TICKS)).toEqual([{ id: p.id, by: first.id, points: REVIVE_POINTS }]);
    expect([first.score, second.score]).toEqual([REVIVE_POINTS, 0]);
  });

  test("when the holder walks off, the other reviver takes over from 0 and scores alone", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400], [1600, 1600]);
    const [p, holder, other] = [ps[0]!, ps[1]!, ps[2]!];
    downNow(a, p);
    beside(p, holder, 20);
    beside(p, other, -50);
    revivesOver(a, 30);
    expect([p.reviver, p.reviveTicks]).toEqual([holder.id, 30]);
    beside(p, holder, 300);
    stepQuiet(a); // the holder's loss resets, and the other takes hold in the same step
    expect([p.reviver, p.reviveTicks]).toEqual([other.id, 1]);
    expect(revivesOver(a, REVIVE_TICKS - 2)).toEqual([]);
    expect(revivesOver(a, 1)).toEqual([{ id: p.id, by: other.id, points: REVIVE_POINTS }]);
    expect([other.score, holder.score]).toEqual([REVIVE_POINTS, 0]);
  });

  test("a revive counts once per down; a later down revived again scores again", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [p, h] = [ps[0]!, ps[1]!];
    downNow(a, p);
    beside(p, h, 30);
    expect(revivesOver(a, REVIVE_TICKS + 60).length).toBe(1);
    expect(h.score).toBe(REVIVE_POINTS);
    // One hit left: the next hit puts it down again.
    expect(p.hits).toBe(HITS_PER_LIFE - 1);
    p.invulnTicks = 0;
    placeBug(a, p.x + 5, p.y);
    stepQuiet(a);
    expect(p.down).toBe(true);
    expect(a.events.downs).toEqual([p.id]);
    expect(revivesOver(a, REVIVE_TICKS).length).toBe(1);
    expect(h.score).toBe(2 * REVIVE_POINTS);
  });

  test("a revive completing on the bleed-out step wins", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [p, h] = [ps[0]!, ps[1]!];
    downNow(a, p);
    // Walk in so the 40th step in range is the bleed-out step.
    stepQuiet(a, DOWN_TICKS - REVIVE_TICKS);
    beside(p, h, 30);
    stepQuiet(a, REVIVE_TICKS - 1);
    expect(a.tick - p.downTick).toBe(DOWN_TICKS);
    stepQuiet(a);
    expect(a.events.revives.length).toBe(1);
    expect(a.events.livesEnded).toEqual([]);
    expect([p.alive, p.down]).toEqual([true, false]);
  });

  test("a downed player can't revive another downed player", () => {
    const { a, ps } = arenaWith([1200, 1200], [1230, 1200]);
    const [p, q] = [ps[0]!, ps[1]!];
    downNow(a, p);
    downNow(a, q);
    expect(revivesOver(a, REVIVE_TICKS + 5)).toEqual([]);
    expect([p.reviver, q.reviver]).toEqual([0, 0]);
  });

  test("a holder who goes down loses its hold", () => {
    const { a, ps } = arenaWith([1200, 1200], [1400, 1400]);
    const [p, h] = [ps[0]!, ps[1]!];
    downNow(a, p);
    beside(p, h, 50);
    revivesOver(a, 10);
    downNow(a, h);
    expect([p.reviver, p.reviveTicks]).toEqual([0, 0]);
    expect(revivesOver(a, REVIVE_TICKS)).toEqual([]);
  });

  test("leaving while down ends the life and returns it; a downed player's shot in flight still scores", () => {
    // q is along the shot's line, so the bug walks straight away from p into the shot.
    const { a, ps } = arenaWith([1200, 1200], [2300, 1200]);
    const [p, q] = [ps[0]!, ps[1]!];
    placeBug(a, 1500, 1200);
    hold(p, { fire: true });
    stepQuiet(a);
    hold(p, {});
    downNow(a, p);
    let kill = null;
    for (let i = 0; i < 20 && !kill; i++) {
      stepQuiet(a);
      kill = a.events.kills.find((k) => k.by === p.id) ?? null;
    }
    expect(kill).toMatchObject({ by: p.id, points: 10 });
    expect(p.score).toBe(10);
    q.score = 5;
    downNow(a, q);
    expect(leavePlayer(a, q.id)).toEqual({ life: { id: q.id, score: 5, kills: 0, ticks: a.tick } });
    bleedNow(a, p);
    expect(a.events.livesEnded).toEqual([{ id: p.id, score: 10, kills: 1, ticks: a.tick - 1 }]);
  });
});
