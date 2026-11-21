import { describe, expect, test } from "bun:test";
import { ARENA_AREA, arenaForViewport } from "./arena";
import { createState, score, step, type Bug, type Input, type State } from "./sim";

const DT = 1 / 60;
const TALL = { w: 450, h: 800 };
const WIDE = { w: 800, h: 450 };
const NONE: Input = { kind: "none" };

function run(state: State, input: Input, steps: number) {
  for (let i = 0; i < steps; i++) step(state, input, DT);
}

/** A state with spawning switched off, for tests that place their own bugs. */
function quiet(): State {
  const s = createState(1, TALL);
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

  test("the robot stays inside the arena", () => {
    const s = quiet();
    run(s, { kind: "direction", dx: -1, dy: -1 }, 300);
    expect(s.robot).toEqual({ x: 14, y: 14 });
    run(s, { kind: "target", x: 5000, y: 5000 }, 600);
    expect(s.robot).toEqual({ x: 436, y: 786 });
  });
});

describe("bugs", () => {
  test("spawn at a steady rate, just outside an edge", () => {
    const s = createState(3, WIDE);
    let seen = new Set<Bug>();
    let checked = 0;
    for (let i = 0; i < 294; i++) {
      step(s, NONE, DT); // 4.9 s: one bug every 0.48 s is 10
      for (const b of s.bugs) {
        if (seen.has(b)) continue;
        checked++;
        expect(b.x <= 0 || b.x >= 800 || b.y <= 0 || b.y >= 450).toBe(true);
      }
      seen = new Set(s.bugs);
    }
    expect(s.spawned).toBe(10);
    expect(checked).toBe(10);
    run(s, NONE, 288); // 4.8 s more
    expect(s.spawned).toBe(20);
  });

  test("chase the robot", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 50, hp: 1000 });
    step(s, NONE, DT);
    expect(s.bugs[0]!.y).toBeCloseTo(51.5, 5); // 90 units/s toward the robot at (225, 400)
    s.robot.x = 450 - 14;
    const before = Math.hypot(s.bugs[0]!.x - s.robot.x, s.bugs[0]!.y - s.robot.y);
    step(s, NONE, DT);
    const after = Math.hypot(s.bugs[0]!.x - s.robot.x, s.bugs[0]!.y - s.robot.y);
    expect(before - after).toBeCloseTo(1.5, 5);
  });
});

describe("auto-fire", () => {
  test("fires at the nearest bug", () => {
    const s = quiet();
    s.bugs.push({ x: 425, y: 400, hp: 2 }); // 200 to the right
    s.bugs.push({ x: 225, y: 300, hp: 2 }); // 100 above: nearer
    step(s, NONE, DT);
    expect(s.shots).toHaveLength(1);
    expect(s.shots[0]!.vx).toBeCloseTo(0, 5);
    expect(s.shots[0]!.vy).toBeCloseTo(-700, 5);
  });

  test("holds fire with no bugs, and fires 4 shots a second with one", () => {
    const s = quiet();
    run(s, NONE, 60);
    expect(s.shots).toHaveLength(0);
    s.bugs.push({ x: 225, y: 100, hp: 1000 });
    run(s, NONE, 60); // shots at 0, 0.25, 0.5 and 0.75 s, each either in flight or spent on the bug
    expect(s.shots.length + (1000 - s.bugs[0]!.hp)).toBe(4);
  });
});

describe("scoring", () => {
  test("a squash scores 10 and each whole second survived scores 1", () => {
    const s = quiet();
    s.bugs.push({ x: 225, y: 250, hp: 2 });
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
    s.bugs.push({ x: 225, y: 400, hp: 1000 });
    step(s, NONE, DT);
    expect(s.hits).toBe(1);
    expect(s.bugs).toHaveLength(0);

    s.bugs.push({ x: 225, y: 400, hp: 1000 });
    run(s, NONE, 30); // half a second: still invulnerable
    expect(s.hits).toBe(1);
    expect(s.bugs).toHaveLength(1);
    run(s, NONE, 32); // invulnerability over: the waiting bug hits
    expect(s.hits).toBe(2);
    expect(s.over).toBe(false);

    s.bugs.push({ x: 225, y: 400, hp: 1000 });
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

test("an idle player loses within 30 to 60 seconds, portrait and landscape", () => {
  for (const arena of [TALL, WIDE]) {
    for (let seed = 1; seed <= 10; seed++) {
      const s = createState(seed, arena);
      while (!s.over && s.time < 120) step(s, NONE, DT);
      expect(s.over).toBe(true);
      expect(s.time).toBeGreaterThanOrEqual(30);
      expect(s.time).toBeLessThanOrEqual(60);
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
