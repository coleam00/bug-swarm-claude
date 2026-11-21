import { describe, expect, test } from "bun:test";
import { arenaForViewport, type Arena } from "./arena";
import { MAX_SQUASHES_PER_SECOND } from "../../server/rules";
import {
  ARENA_AREA,
  BASE_BUG,
  BUG_KINDS,
  FIRE_INTERVAL,
  ROBOT_RADIUS,
  ROBOT_SPEED,
  SPAWN_MIN,
  SPAWN_START,
  spawnInterval,
} from "./config";
import { createState, pickKind, score, step, type Bug, type Input, type State } from "./sim";

const DT = 1 / 60;
const TALL = { w: 450, h: 800 };
const WIDE = { w: 800, h: 450 };
const FOUR_THREE = { w: 693, h: 520 };
const NONE: Input = { kind: "none" };

function run(state: State, input: Input, steps: number) {
  for (let i = 0; i < steps; i++) step(state, input, DT);
}

/** Steps a run whose robot never takes a hit, to watch the swarm past where a player would lose. */
function keepAlive(state: State, input: Input, steps: number) {
  for (let i = 0; i < steps; i++) {
    step(state, input, DT);
    state.hits = 0;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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
        step(s, NONE, DT);
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

  test("dies to the first shot that lands", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 250, hp: FAST.hp, kind: FAST });
    while (s.squashes === 0 && s.time < 1) step(s, NONE, DT);
    expect(s.squashes).toBe(1);
    expect(s.bugs).toHaveLength(0);
    expect(s.shots).toHaveLength(0);
    expect(s.time).toBeLessThan(FIRE_INTERVAL); // so only the first shot had been fired
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
    while (!s.over && s.time < 120) step(s, NONE, DT); // bounded: a tuning change fails, never hangs
    expect(s.over).toBe(true);
    const snapshot = structuredClone(s);
    run(s, { kind: "direction", dx: 1, dy: 0 }, 120);
    expect(s).toEqual(snapshot);
  });
});

test("the same seed plays the same run; another seed doesn't", () => {
  const play = (seed: number) => {
    const s = createState(seed, WIDE);
    for (let i = 0; i < 1200; i++) step(s, { kind: "direction", dx: Math.sin(i / 50), dy: Math.cos(i / 70) }, DT);
    return s;
  };
  expect(play(7)).toEqual(play(7));
  expect(play(7)).not.toEqual(play(8));
});

test("an idle player loses within 30 to 60 seconds, portrait, landscape and 4:3", () => {
  for (const arena of [TALL, WIDE, FOUR_THREE]) {
    for (let seed = 1; seed <= 10; seed++) {
      const s = createState(seed, arena);
      while (!s.over && s.time < 120) step(s, NONE, DT);
      expect(s.over).toBe(true);
      expect(s.time).toBeGreaterThanOrEqual(30);
      expect(s.time).toBeLessThanOrEqual(60);
    }
  }
});

test("a player who keeps moving outlasts an idle one", () => {
  // A scripted player is no human, so this only checks that moving pays, not the 1 to 3 minute
  // target: that is checked by playing.
  for (const arena of [TALL, WIDE]) {
    const idle: number[] = [];
    const moving: number[] = [];
    for (let seed = 1; seed <= 10; seed++) {
      const a = createState(seed, arena);
      while (!a.over && a.time < 300) step(a, NONE, DT);
      idle.push(a.time);
      const b = createState(seed, arena);
      while (!b.over && b.time < 300) step(b, dodge(b), DT);
      moving.push(b.time);
    }
    expect(median(moving)).toBeGreaterThanOrEqual(median(idle) + 10);
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

describe("the server's squash cap", () => {
  test("a shot squashes at most one bug, so the fire rate bounds squashes under the cap", () => {
    expect(1 / FIRE_INTERVAL).toBeLessThanOrEqual(MAX_SQUASHES_PER_SECOND);
  });

  test("a robot that never dies, deep in the ramp, squashes no faster than it fires", () => {
    for (let seed = 1; seed <= 3; seed++) {
      const s = createState(seed, TALL);
      keepAlive(s, NONE, 120 * 60);
      expect(s.squashes / s.time).toBeLessThanOrEqual(1 / FIRE_INTERVAL);
    }
  });
});
