import { TEST_SHIELD } from "../../../server/rules";
import { describe, expect, test } from "bun:test";
import { BASE_BUG } from "../config";
import { createRng } from "../rng";
import { choose, createState, step, type Bug, type Input, type State } from "../sim";
import { createChanges, detectChanges, type Changes } from "./changes";

const DT = 1 / 60;
const NONE: Input = { kind: "none" };

/** A state with spawning switched off, robot at (300, 550), for tests that place their own bugs. */
function quiet(): State {
  const s = createState(1, { w: 600, h: 1100 });
  s.spawnTimer = Infinity;
  return s;
}

/** Runs `steps` sim steps as one frame, then detects what changed, as the loop does. */
function frame(s: State, c: Changes, steps: number) {
  const squashed: Bug[] = [];
  const hits: { x: number; y: number }[] = [];
  const blocks: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i++) step(s, NONE, DT);
  detectChanges(c, s, (b) => squashed.push(b), (x, y) => hits.push({ x, y }), (x, y) => blocks.push({ x, y }));
  return { squashed, hits, blocks };
}

describe("changes between frames", () => {
  test("a bug squashed by shots is reported once, where it died", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    const bug = { x: 300, y: 400, hp: 2, kind: BASE_BUG };
    s.bugs.push(bug);
    expect(frame(s, c, 0).squashed).toHaveLength(0);
    const { squashed, hits } = frame(s, c, 30); // two shots land within half a second
    expect(s.squashes).toBe(1);
    expect(squashed).toEqual([bug]);
    expect(bug.y).toBeGreaterThan(400); // it had walked toward the robot
    expect(hits).toHaveLength(0);
    expect(frame(s, c, 1).squashed).toHaveLength(0); // and not again
  });

  test("a bug touching the robot is a hit at the robot, not a squash", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    s.bugs.push({ x: 300, y: 550, hp: 1000, kind: BASE_BUG });
    frame(s, c, 0);
    const { squashed, hits } = frame(s, c, 1);
    expect(s.hits).toBe(1);
    expect(hits).toEqual([{ x: 300, y: 550 }]);
    expect(squashed).toHaveLength(0);
  });

  test("a bug the test shield blocked is a block at the robot, not a squash or a hit", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    s.shield = 1;
    s.bugs.push({ x: 300, y: 550, hp: 1000, kind: BASE_BUG });
    frame(s, c, 0);
    const { squashed, hits, blocks } = frame(s, c, 1);
    expect(s.blocks).toBe(1);
    expect(blocks).toEqual([{ x: 300, y: 550 }]);
    expect(hits).toHaveLength(0);
    expect(squashed).toHaveLength(0);
    expect(frame(s, c, 1).blocks).toHaveLength(0); // and not again
  });

  test("two squashes in one frame are both reported", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    const a = { x: 300, y: 450, hp: 1, kind: BASE_BUG };
    const b = { x: 300, y: 350, hp: 1, kind: BASE_BUG };
    s.bugs.push(a, b);
    frame(s, c, 0);
    const { squashed } = frame(s, c, 60); // shots at 0 and 0.25 s
    expect(s.squashes).toBe(2);
    expect(squashed).toHaveLength(2);
    expect(squashed).toContain(a);
    expect(squashed).toContain(b);
  });

  test("a squash and a hit in the same frame: the bug at the robot is the hit", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    const touching = { x: 300, y: 550, hp: 1000, kind: BASE_BUG };
    const far = { x: 300, y: 450, hp: 1, kind: BASE_BUG };
    s.bugs.push(touching, far);
    frame(s, c, 0);
    const { squashed, hits } = frame(s, c, 30);
    expect(s.hits).toBe(1);
    expect(s.squashes).toBe(1);
    expect(hits).toHaveLength(1);
    expect(squashed).toEqual([far]);
  });

  test("a bug moved to another index by a removal is not reported, and keeps its leg phase", () => {
    const s = quiet();
    const c = createChanges(createRng(1));
    const near = { x: 300, y: 450, hp: 1, kind: BASE_BUG };
    const mid = { x: 300, y: 50, hp: 1000, kind: BASE_BUG };
    const last = { x: 590, y: 50, hp: 1000, kind: BASE_BUG };
    s.bugs.push(near, mid, last);
    frame(s, c, 0);
    const lastPhase = c.phase[2]!;
    const midPhase = c.phase[1]!;
    expect(lastPhase).not.toBe(midPhase); // real phases, so a lost phase swap shows below
    const { squashed, hits } = frame(s, c, 20);
    expect(squashed).toEqual([near]);
    expect(hits).toHaveLength(0);
    expect(s.bugs).toEqual([last, mid]); // the sim swapped the last bug into the gap
    expect(c.phase[0]).toBe(lastPhase);
    expect(c.phase[1]).toBe(midPhase);
  });

  test("detecting changes never changes the run", () => {
    const play = (detect: boolean) => {
      const s = createState(7, { w: 1100, h: 600 });
      const c = createChanges(createRng(1));
      for (let i = 0; i < 1800 && !s.over; i++) {
        step(s, { kind: "direction", dx: Math.sin(i / 50), dy: Math.cos(i / 70) }, DT);
        if (s.choice) choose(s, 0);
        if (detect) detectChanges(c, s, () => {}, () => {}, () => {});
      }
      return s;
    };
    expect(play(true)).toEqual(play(false));
  });

  test("over a whole run, every squash, hit and block is reported exactly once", () => {
    const s = createState(7, { w: 1100, h: 600 });
    const c = createChanges(createRng(1));
    let squashes = 0;
    let hits = 0;
    let blocks = 0;
    // Until the run has had squashes, a hit and a block to report (upgrades can make it long), at most 15 min.
    const seen = () => s.squashes > 10 && s.hits > 0 && s.blocks > 0;
    for (let i = 0; i < 54_000 && !s.over && !(i >= 7200 && seen()); i++) {
      step(s, { kind: "direction", dx: Math.sin(i / 50), dy: Math.cos(i / 70) }, DT);
      // Take the shield whenever it is offered, so the run has blocks to report too.
      if (s.choice) choose(s, Math.max(0, s.choice.indexOf(TEST_SHIELD)));
      detectChanges(c, s, () => squashes++, () => hits++, () => blocks++);
    }
    expect(s.squashes).toBeGreaterThan(10);
    expect(s.hits).toBeGreaterThan(0);
    expect(s.blocks).toBeGreaterThan(0);
    expect(squashes).toBe(s.squashes);
    expect(hits).toBe(s.hits);
    expect(blocks).toBe(s.blocks);
  });
});
