import { describe, expect, test } from "bun:test";
import { arenaForViewport, type Arena } from "./arena";
import { MAX_SQUASHES_PER_SECOND, REVIEW_LASER, TEST_SHIELD, UPGRADE_IDS, UPGRADE_MAX_LEVEL, type UpgradeId } from "../../server/rules";
import {
  ARENA_AREA,
  BASE_BUG,
  BUG_KINDS,
  CHOICE_CARDS,
  CHOICE_EVERY,
  FIRE_INTERVAL,
  INVULN_SECONDS,
  LASER_PIERCE,
  MOVING_FIRE_RATE,
  ROBOT_RADIUS,
  ROBOT_SPEED,
  SHIELD_CHARGES,
  SPAWN_MIN,
  SPAWN_START,
  spawnInterval,
} from "./config";
import { choose, createState, pickKind, runResult, score, step, type Bug, type Input, type State } from "./sim";

const DT = 1 / 60;
const TALL = { w: 450, h: 800 };
const WIDE = { w: 800, h: 450 };
const FOUR_THREE = { w: 693, h: 520 };
const NONE: Input = { kind: "none" };

/**
 * Steps the run once, taking card `pick` of any choice that comes up (a run waiting for a
 * choice doesn't advance, so a loop that never picks would spin at 20 s).
 */
function advance(state: State, input: Input, pick = 0) {
  step(state, input, DT);
  if (state.choice) choose(state, Math.min(pick, state.choice.length - 1));
}

/** Takes the card for upgrade `id` from the choice on offer, which must have it. */
function takeCard(state: State, id: UpgradeId) {
  const index = state.choice?.indexOf(id) ?? -1;
  expect(index).toBeGreaterThanOrEqual(0);
  expect(choose(state, index)).toBe(true);
}

/** Steps without picking until a choice comes up (bounded), keeping the robot alive. */
function toChoice(s: State, input: Input = NONE) {
  const limit = s.time + CHOICE_EVERY + 1;
  while (!s.choice && s.time < limit) {
    step(s, input, DT);
    s.hits = 0;
  }
}

function run(state: State, input: Input, steps: number) {
  for (let i = 0; i < steps; i++) advance(state, input);
}

/** Steps a run whose robot never takes a hit, to watch the swarm past where a player would lose. */
function keepAlive(state: State, input: Input, steps: number) {
  for (let i = 0; i < steps; i++) {
    advance(state, input);
    state.hits = 0;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A scripted player that circles the middle of the arena at full speed. */
function circle(s: State): Input {
  const r = 0.2 * Math.min(s.arena.w, s.arena.h);
  const a = (s.time * ROBOT_SPEED) / r;
  return { kind: "target", x: s.arena.w / 2 + r * Math.cos(a), y: s.arena.h / 2 + r * Math.sin(a) };
}

/**
 * A scripted player that keeps moving: of 24 headings it takes the one that stays clearest of
 * the bugs (each assumed to come straight at it) and the walls over the next 0.8 s.
 */
function dodge(s: State): Input {
  const { x, y } = s.robot;
  const { w, h } = s.arena;
  let best = -Infinity;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < 24; k++) {
    const a = (k * Math.PI) / 12;
    let worst = Infinity;
    for (const t of [0.1, 0.25, 0.5, 0.8]) {
      const px = Math.min(Math.max(x + Math.cos(a) * ROBOT_SPEED * t, ROBOT_RADIUS), w - ROBOT_RADIUS);
      const py = Math.min(Math.max(y + Math.sin(a) * ROBOT_SPEED * t, ROBOT_RADIUS), h - ROBOT_RADIUS);
      for (const b of s.bugs) {
        const gap = Math.hypot(px - b.x, py - b.y) - b.kind.speed * t - ROBOT_RADIUS - b.kind.radius;
        worst = Math.min(worst, gap / (t + 0.2));
      }
      const wall = Math.min(px, py, w - px, h - py) - ROBOT_RADIUS;
      worst = Math.min(worst, wall / (t + 0.2) + 60);
    }
    if (worst > best) {
      best = worst;
      dx = Math.cos(a);
      dy = Math.sin(a);
    }
  }
  return { kind: "direction", dx, dy };
}

/** A state with spawning switched off, for tests that place their own bugs. */
function quiet(arena: Arena = TALL): State {
  const s = createState(1, arena);
  s.spawnTimer = Infinity;
  return s;
}

describe("steering", () => {
  test("a target moves the robot toward it at full speed and stops there", () => {
    const s = quiet();
    expect(s.robot).toEqual({ x: 225, y: 400 });
    run(s, { kind: "target", x: 325, y: 400 }, 6); // 0.1 s at 260 units/s
    expect(s.robot.x).toBeCloseTo(251, 3);
    run(s, { kind: "target", x: 325, y: 400 }, 54);
    expect(s.robot).toEqual({ x: 325, y: 400 });
  });

  test("a direction moves the robot at full speed, whatever its length", () => {
    const s = quiet();
    run(s, { kind: "direction", dx: 5, dy: 5 }, 30); // 0.5 s: 130 units along the diagonal
    expect(s.robot.x).toBeCloseTo(316.924, 2);
    expect(s.robot.y).toBeCloseTo(491.924, 2);
  });

  test("the robot stays inside the arena, portrait and landscape", () => {
    for (const arena of [TALL, WIDE]) {
      const s = quiet(arena);
      run(s, { kind: "direction", dx: -1, dy: -1 }, 300);
      expect(s.robot).toEqual({ x: 14, y: 14 });
      run(s, { kind: "target", x: 5000, y: 5000 }, 600);
      expect(s.robot).toEqual({ x: arena.w - 14, y: arena.h - 14 });
    }
  });
});

describe("bugs", () => {
  test("spawn just outside all four edges, at the rate the ramp sets, portrait and landscape", () => {
    for (const arena of [TALL, WIDE]) {
      const s = createState(3, arena);
      let seen = new Set<Bug>();
      const edges = new Set<string>();
      let checked = 0;
      while (s.time < 10) {
        advance(s, NONE);
        for (const b of s.bugs) {
          if (seen.has(b)) continue;
          checked++;
          const edge = b.y < 0 ? "top" : b.x > arena.w ? "right" : b.y > arena.h ? "bottom" : b.x < 0 ? "left" : "inside";
          expect(edge).not.toBe("inside");
          edges.add(edge);
        }
        seen = new Set(s.bugs);
      }
      expect(checked).toBe(s.spawned);
      expect([...edges].sort()).toEqual(["bottom", "left", "right", "top"]);
      // The interval shrinks over these 10 s, so the count sits between the start's rate and the 10th second's.
      expect(s.spawned).toBeGreaterThanOrEqual(Math.floor(10 / spawnInterval(0)));
      expect(s.spawned).toBeLessThanOrEqual(Math.ceil(10 / spawnInterval(10)));
    }
  });

  test("the swarm ramps: spawns come faster as the run goes on, down to a floor", () => {
    for (let t = 1; t <= 120; t++) expect(spawnInterval(t)).toBeLessThanOrEqual(spawnInterval(t - 1));
    expect(spawnInterval(0)).toBe(SPAWN_START);
    expect(spawnInterval(120)).toBe(SPAWN_MIN);
    for (let seed = 1; seed <= 5; seed++) {
      const s = createState(seed, TALL);
      const spawnedAt: number[] = [];
      for (let second = 0; second < 30; second++) {
        spawnedAt.push(s.spawned);
        keepAlive(s, NONE, 60);
      }
      const early = spawnedAt[10]! - spawnedAt[0]!;
      const late = s.spawned - spawnedAt[20]!;
      expect(late).toBeGreaterThan(early);
    }
  });

  test("chase the robot", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 50, hp: 1000, kind: BASE_BUG });
    step(s, NONE, DT);
    expect(s.bugs[0]!.y).toBeCloseTo(50 + BASE_BUG.speed * DT, 5); // straight toward the robot at (225, 400)
    s.robot.x = 450 - 14;
    const before = Math.hypot(s.bugs[0]!.x - s.robot.x, s.bugs[0]!.y - s.robot.y);
    step(s, NONE, DT);
    const after = Math.hypot(s.bugs[0]!.x - s.robot.x, s.bugs[0]!.y - s.robot.y);
    expect(before - after).toBeCloseTo(BASE_BUG.speed * DT, 5);
  });
});

describe("the fast bug", () => {
  const FAST = BUG_KINDS.find((k) => k.id === "fast")!;

  test("is small, at least 1.5x the base speed, and takes one shot", () => {
    expect(FAST.radius).toBeLessThan(BASE_BUG.radius);
    expect(FAST.speed).toBeGreaterThanOrEqual(1.5 * BASE_BUG.speed);
    expect(FAST.hp).toBe(1);
    const s = quiet();
    s.bugs.push({ x: 225, y: 50, hp: 1000, kind: FAST });
    step(s, NONE, DT);
    expect(s.bugs[0]!.y).toBeCloseTo(50 + FAST.speed * DT, 5);
  });

  test("only spawns from 30 seconds in", () => {
    for (let roll = 0; roll < 1; roll += 0.05) {
      expect(pickKind(0, roll)).toBe(BASE_BUG);
      expect(pickKind(29.99, roll)).toBe(BASE_BUG);
    }
    expect(pickKind(30, 0)).toBe(FAST);
    expect(pickKind(30, 0.99)).toBe(BASE_BUG);
    for (let seed = 1; seed <= 5; seed++) {
      const s = createState(seed, TALL);
      let fastAt = Infinity;
      while (s.time < 45 && fastAt === Infinity) {
        keepAlive(s, NONE, 1);
        if (s.bugs.some((b) => b.kind === FAST)) fastAt = s.time;
      }
      expect(fastAt).toBeGreaterThanOrEqual(30);
      expect(fastAt).toBeLessThan(45);
    }
  });

  test("a fast bug the swarm spawns dies to the first shot that lands", () => {
    const s = createState(1, TALL);
    let fast: Bug | undefined;
    while (!fast && s.time < 45) {
      keepAlive(s, NONE, 1);
      fast = s.bugs.find((b) => b.kind === FAST);
    }
    // Keep only that bug, in front of the robot, and watch one shot meet it.
    s.bugs = [fast!];
    s.shots = [];
    s.spawnTimer = Infinity;
    s.fireTimer = 0;
    s.levels[REVIEW_LASER] = 0; // a plain shot, so it ends on the bug
    fast!.x = s.robot.x;
    fast!.y = s.robot.y - 150;
    const squashes = s.squashes;
    const start = s.time;
    while (s.squashes === squashes && s.time - start < 1) advance(s, NONE);
    expect(s.squashes).toBe(squashes + 1);
    expect(s.bugs).toHaveLength(0);
    expect(s.shots).toHaveLength(0);
    expect(s.time - start).toBeLessThan(FIRE_INTERVAL); // so only the first shot had been fired
  });
});

describe("auto-fire", () => {
  test("fires at the nearest bug", () => {
    const s = quiet();
    s.bugs.push({ x: 425, y: 400, hp: 2, kind: BASE_BUG }); // 200 to the right
    s.bugs.push({ x: 225, y: 300, hp: 2, kind: BASE_BUG }); // 100 above: nearer
    step(s, NONE, DT);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.vx).toBeCloseTo(0, 5);
    expect(s.shots[0]!.vy).toBeCloseTo(-700, 5);
  });

  test("holds fire with no bugs, and fires 4 shots a second with one", () => {
    const s = quiet();
    run(s, NONE, 60);
    expect(s.shots).toHaveLength(0);
    s.bugs.push({ x: 225, y: 100, hp: 1000, kind: BASE_BUG });
    run(s, NONE, 60); // shots at 0, 0.25, 0.5 and 0.75 s, each either in flight or spent on the bug
    expect(s.shots.length + (1000 - s.bugs[0]!.hp)).toBe(4);
  });

  test("reloads MOVING_FIRE_RATE times faster while the robot moves, not while it pushes into a wall", () => {
    const shotsInASecond = (s: State, input: (i: number) => Input) => {
      s.bugs.push({ x: 225, y: 100, hp: 1000, kind: BASE_BUG });
      for (let i = 0; i < 60; i++) step(s, input(i), DT);
      return s.shots.length + (1000 - s.bugs[0]!.hp);
    };
    // Side to side, so the robot moves every step: a shot every 0.25 / 1.8 s, 8 in the second.
    const jiggle = (i: number): Input => ({ kind: "direction", dx: i % 2 ? 1 : -1, dy: 0 });
    expect(shotsInASecond(quiet(), jiggle)).toBe(Math.ceil(MOVING_FIRE_RATE / FIRE_INTERVAL));
    const walled = quiet();
    walled.robot.x = 450 - 14;
    expect(shotsInASecond(walled, () => ({ kind: "direction", dx: 1, dy: 0 }))).toBe(4);
  });
});

describe("scoring", () => {
  test("a squash scores 10 and each whole second survived scores 1", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 250, hp: 2, kind: BASE_BUG });
    run(s, NONE, 30); // two shots hit it within half a second
    expect(s.squashes).toBe(1);
    expect(s.bugs).toHaveLength(0);
    expect(score(s)).toBe(10);
    run(s, NONE, 31);
    expect(score(s)).toBe(11);
    run(s, NONE, 60);
    expect(score(s)).toBe(12);
  });
});

describe("hits", () => {
  test("a touching bug costs one hit, invulnerability blocks the next, the third hit ends the run", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 400, hp: 1000, kind: BASE_BUG });
    step(s, NONE, DT);
    expect(s.hits).toBe(1);
    expect(s.bugs).toHaveLength(0);

    s.bugs.push({ x: 225, y: 400, hp: 1000, kind: BASE_BUG });
    run(s, NONE, 30); // half a second: still invulnerable
    expect(s.hits).toBe(1);
    expect(s.bugs).toHaveLength(1);
    run(s, NONE, 32); // invulnerability over: the waiting bug hits
    expect(s.hits).toBe(2);
    expect(s.over).toBe(false);

    s.bugs.push({ x: 225, y: 400, hp: 1000, kind: BASE_BUG });
    run(s, NONE, 62);
    expect(s.hits).toBe(3);
    expect(s.over).toBe(true);
  });

  test("stepping a finished run changes nothing", () => {
    const s = createState(5, TALL);
    while (!s.over && s.time < 120) advance(s, NONE); // bounded: a tuning change fails, never hangs
    expect(s.over).toBe(true);
    const snapshot = structuredClone(s);
    run(s, { kind: "direction", dx: 1, dy: 0 }, 120);
    expect(s).toEqual(snapshot);
  });
});

test("the same seed plays the same run; another seed doesn't", () => {
  const play = (seed: number) => {
    const s = createState(seed, WIDE);
    for (let i = 0; i < 1800; i++) advance(s, { kind: "direction", dx: Math.sin(i / 50), dy: Math.cos(i / 70) });
    return s;
  };
  expect(play(7)).toEqual(play(7));
  expect(play(7)).not.toEqual(play(8));
});

test("an idle player loses within 30 to 60 seconds, portrait, landscape and 4:3", () => {
  for (const arena of [TALL, WIDE, FOUR_THREE]) {
    for (let seed = 1; seed <= 10; seed++) {
      const s = createState(seed, arena);
      while (!s.over && s.time < 120) advance(s, NONE);
      expect(s.over).toBe(true);
      expect(s.time).toBeGreaterThanOrEqual(30);
      expect(s.time).toBeLessThanOrEqual(60);
    }
  }
});

test("a player who keeps moving survives 1 to 3 minutes, portrait and landscape", () => {
  // Two scripted movers: one circling the middle, as a thumb can, and one dodging. Each run is
  // bounded, so a tuning change fails rather than hangs.
  for (const arena of [TALL, WIDE]) {
    for (const player of [circle, dodge]) {
      const times: number[] = [];
      for (let seed = 1; seed <= 10; seed++) {
        const s = createState(seed, arena);
        while (!s.over && s.time < 240) advance(s, player(s));
        times.push(s.time);
      }
      expect(median(times)).toBeGreaterThanOrEqual(60);
      expect(median(times)).toBeLessThanOrEqual(180);
    }
  }
});

test("the arena keeps 360,000 units² and the screen's ratio, clamped to 9:16..16:9", () => {
  const cases: [number, number, { w: number; h: number }][] = [
    [390, 844, { w: 450, h: 800 }], // phone portrait: taller than 9:16, clamped
    [844, 390, { w: 800, h: 450 }], // phone landscape: wider than 16:9, clamped
    [300, 1000, { w: 450, h: 800 }],
    [2000, 400, { w: 800, h: 450 }],
    [800, 600, { w: 693, h: 520 }], // 4:3, inside the clamp: the screen's own ratio
    [1440, 900, { w: 759, h: 474 }], // a 16:10 desktop
    [600, 600, { w: 600, h: 600 }],
    [0, 0, { w: 600, h: 600 }],
  ];
  for (const [w, h, arena] of cases) {
    expect(arenaForViewport(w, h)).toEqual(arena);
    expect(Math.abs(arena.w * arena.h - ARENA_AREA) / ARENA_AREA).toBeLessThan(0.005);
  }
});

describe("upgrade choices", () => {
  test("every 20 s of run time play pauses on up to 3 different upgrades, and a pick resumes it", () => {
    const s = createState(2, TALL);
    toChoice(s);
    expect(s.time).toBeCloseTo(CHOICE_EVERY, 5);
    const cards = s.choice!;
    expect(cards.length).toBe(Math.min(CHOICE_CARDS, UPGRADE_IDS.length));
    expect(new Set(cards).size).toBe(cards.length);
    for (const id of cards) expect(UPGRADE_IDS).toContain(id);

    // While the choice waits nothing moves and no time is survived.
    const frozen = structuredClone(s);
    for (let i = 0; i < 120; i++) step(s, { kind: "direction", dx: 1, dy: 0 }, DT);
    expect(s).toEqual(frozen);

    expect(choose(s, 0)).toBe(true);
    expect(s.choice).toBeNull();
    expect(s.taken).toEqual([cards[0]!]);
    expect(s.levels[cards[0]!]).toBe(1);
    step(s, NONE, DT);
    expect(s.time).toBeGreaterThan(CHOICE_EVERY);
    toChoice(s);
    expect(s.time).toBeCloseTo(2 * CHOICE_EVERY, 5);
  });

  test("choose refuses a card that isn't there, or no choice at all", () => {
    const s = createState(2, TALL);
    expect(choose(s, 0)).toBe(false);
    toChoice(s);
    const before = structuredClone(s);
    for (const bad of [-1, s.choice!.length, 0.5, NaN]) expect(choose(s, bad)).toBe(false);
    expect(s).toEqual(before);
  });

  test("the draw is seeded from the run's seed, and taking a choice never changes the swarm", () => {
    const draws = (seed: number) => {
      const s = createState(seed, TALL);
      const seen: UpgradeId[][] = [];
      while (s.time < 3 * CHOICE_EVERY + 1) {
        step(s, NONE, DT);
        s.hits = 0;
        if (s.choice) {
          seen.push([...s.choice]);
          choose(s, seen.length % s.choice.length);
        }
      }
      return seen;
    };
    expect(draws(11)).toEqual(draws(11));

    // A run that takes its choices spawns exactly what a run with no choices does.
    const picking = createState(4, TALL);
    const control = createState(4, TALL);
    control.nextChoiceAt = Infinity;
    keepAlive(picking, NONE, 25 * 60);
    keepAlive(control, NONE, 25 * 60);
    expect(picking.taken.length).toBe(1);
    expect(picking.spawned).toBe(control.spawned);
    expect(picking.rng).toEqual(control.rng);
  });

  test("an upgrade at its top level leaves the pool; with every one maxed, play no longer pauses", () => {
    const s = createState(3, TALL);
    const picks = UPGRADE_IDS.length * UPGRADE_MAX_LEVEL;
    for (let n = 0; n < picks; n++) {
      toChoice(s);
      expect(s.choice).not.toBeNull();
      for (const id of s.choice!) expect(s.levels[id]).toBeLessThan(UPGRADE_MAX_LEVEL);
      choose(s, 0);
    }
    for (const id of UPGRADE_IDS) expect(s.levels[id]).toBe(UPGRADE_MAX_LEVEL);
    const end = s.time + 2 * CHOICE_EVERY;
    while (s.time < end) {
      step(s, NONE, DT);
      s.hits = 0;
      expect(s.choice).toBeNull();
    }
  });
});

describe("review laser", () => {
  const FAST = BUG_KINDS.find((k) => k.id === "fast")!;

  /** One shot, straight up through a column of `count` one-shot bugs. Returns the squashes. */
  function oneShot(level: number, count: number, hp: number = FAST.hp) {
    const s = quiet();
    s.levels[REVIEW_LASER] = level;
    s.nextChoiceAt = Infinity;
    for (let i = 0; i < count; i++) s.bugs.push({ x: 225, y: 300 - 30 * i, hp, kind: hp === FAST.hp ? FAST : BASE_BUG });
    step(s, NONE, DT); // fires once at the nearest bug, straight up
    expect(s.shots).toHaveLength(1);
    s.fireTimer = Infinity; // and never again
    for (const b of s.bugs) b.kind = { ...b.kind, speed: 0 }; // the column holds still
    run(s, NONE, 60);
    return s;
  }

  test("a shot squashes 1 bug without it, 2 at level 1 and 4 at level 2", () => {
    expect(LASER_PIERCE[0]).toBe(0);
    expect(oneShot(0, 5).squashes).toBe(1);
    expect(oneShot(1, 5).squashes).toBe(2);
    expect(oneShot(2, 5).squashes).toBe(4);
  });

  test("a piercing shot hits each bug once", () => {
    const s = oneShot(2, 1, BASE_BUG.hp);
    expect(s.squashes).toBe(0);
    expect(s.bugs).toHaveLength(1);
    expect(s.bugs[0]!.hp).toBe(BASE_BUG.hp - 1);
  });

  test("a shot in flight at the pick keeps its pierce; shots fired after it get the new level", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 50, hp: 1000, kind: BASE_BUG }); // far enough that a shot is still in flight
    s.nextChoiceAt = 0.1;
    while (!s.choice && s.time < 1) step(s, NONE, DT);
    const inFlight = s.shots[0]!;
    expect(inFlight.pierce).toBe(0);
    takeCard(s, REVIEW_LASER);
    expect(inFlight.pierce).toBe(0);
    const fired = s.shots.length;
    const limit = s.time + 1;
    while (s.shots.length <= fired && s.time < limit) step(s, NONE, DT);
    expect(s.shots).toContain(inFlight);
    expect(inFlight.pierce).toBe(0);
    expect(s.shots[s.shots.length - 1]!.pierce).toBe(LASER_PIERCE[1]);
  });
});

describe("test shield", () => {
  /** A quiet run that steps through `times` choices, each 0.1 s apart, taking the shield. */
  function shielded(times = 1): State {
    const s = quiet();
    for (let n = 0; n < times; n++) {
      s.nextChoiceAt = s.time + 0.1;
      toChoice(s);
      takeCard(s, TEST_SHIELD);
    }
    s.nextChoiceAt = Infinity;
    return s;
  }
  const touching = (): Bug => ({ x: 225, y: 400, hp: 1000, kind: BASE_BUG });
  /** Steps until the safe window after a hit or block has run out. */
  const waitOut = (s: State) => run(s, NONE, Math.ceil(INVULN_SECONDS / DT) + 2);

  test("taken once, the bubble blocks the next hit: the bug is gone, no life is lost, then hits count again", () => {
    const s = shielded();
    expect(s.levels[TEST_SHIELD]).toBe(1);
    expect(s.shield).toBe(SHIELD_CHARGES[1]);
    s.bugs.push(touching());
    step(s, NONE, DT);
    expect(s.hits).toBe(0);
    expect(s.blocks).toBe(1);
    expect(s.shield).toBe(0);
    expect(s.bugs).toHaveLength(0);
    expect(s.squashes).toBe(0);
    expect(s.invuln).toBe(INVULN_SECONDS);

    waitOut(s);
    s.bugs.push(touching());
    step(s, NONE, DT);
    expect(s.hits).toBe(1);
    expect(s.blocks).toBe(1);
  });

  test("taken twice, it blocks 2 hits; the third costs a life", () => {
    const s = shielded(2);
    expect(s.levels[TEST_SHIELD]).toBe(2);
    expect(s.shield).toBe(SHIELD_CHARGES[2]);
    for (let n = 1; n <= 2; n++) {
      s.bugs.push(touching());
      step(s, NONE, DT);
      expect(s.blocks).toBe(n);
      expect(s.hits).toBe(0);
      waitOut(s);
    }
    expect(s.shield).toBe(0);
    s.bugs.push(touching());
    step(s, NONE, DT);
    expect(s.hits).toBe(1);
  });

  test("a spent bubble taken again holds the second level's 2 charges", () => {
    const s = shielded();
    s.bugs.push(touching());
    step(s, NONE, DT);
    expect(s.shield).toBe(0);
    s.nextChoiceAt = s.time + 0.1;
    toChoice(s);
    takeCard(s, TEST_SHIELD);
    expect(s.shield).toBe(SHIELD_CHARGES[2]);
  });

  test("a clump touching at once pops one charge; the next bug waits out the safe window", () => {
    const s = shielded(2);
    s.bugs.push(touching(), touching());
    step(s, NONE, DT);
    expect(s.blocks).toBe(1);
    expect(s.shield).toBe(1);
    expect(s.bugs).toHaveLength(1);
    waitOut(s);
    expect(s.blocks).toBe(2);
    expect(s.shield).toBe(0);
    expect(s.hits).toBe(0);
  });
});

test("the run's finish carries the upgrades taken, in pick order", () => {
  const s = createState(2, TALL);
  toChoice(s);
  takeCard(s, REVIEW_LASER);
  toChoice(s);
  takeCard(s, TEST_SHIELD);
  expect(s.taken).toEqual([REVIEW_LASER, TEST_SHIELD]);
  expect(runResult(s, true)).toEqual({ score: score(s), squashes: s.squashes, seconds: s.time, touch: true, upgrades: [REVIEW_LASER, TEST_SHIELD] });
  expect(runResult(s, false).upgrades).not.toBe(s.taken); // a copy: the finish can't change with the state
});

describe("the server's squash cap", () => {
  test("squashes never outrun spawns, and spawns come no faster than the cap", () => {
    expect(1 / SPAWN_MIN).toBeLessThanOrEqual(MAX_SQUASHES_PER_SECOND);
    // The laser at every choice it is on, and a robot that never dies: still under the cap for two minutes.
    for (const player of [circle, dodge]) {
      const s = createState(6, WIDE);
      while (s.time < 120) {
        step(s, player(s), DT);
        if (s.choice) choose(s, Math.max(0, s.choice.indexOf(REVIEW_LASER)));
        s.hits = 0;
      }
      expect(s.levels[REVIEW_LASER]).toBe(UPGRADE_MAX_LEVEL);
      expect(s.squashes).toBeLessThanOrEqual(s.spawned);
      expect(s.squashes).toBeLessThanOrEqual(MAX_SQUASHES_PER_SECOND * s.time);
    }
  });
});
