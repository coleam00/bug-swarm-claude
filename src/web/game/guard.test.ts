import { describe, expect, test } from "bun:test";
import { CHOICE_EVERY } from "./config";
import { createChoiceGate, pickChoice, restartIn, showChoice } from "./guard";
import { createState, step, type State } from "./sim";

const DT = 1 / 60;

/** A run stepped (robot kept alive) until its first upgrade choice comes up. */
function atChoice(): State {
  const s = createState(1, { w: 450, h: 800 });
  while (!s.choice && s.time < CHOICE_EVERY + 1) {
    step(s, { kind: "none" }, DT);
    s.hits = 0;
  }
  expect(s.choice).not.toBeNull();
  return s;
}

describe("restart guard", () => {
  test("game over refuses a restart until 800 ms after death", () => {
    const diedAt = 1000;
    expect(restartIn(diedAt, 1000)).toBe(800);
    expect(restartIn(diedAt, 1799)).toBe(1);
    expect(restartIn(diedAt, 1800)).toBe(0);
    expect(restartIn(diedAt, 5000)).toBe(0);
  });
});

describe("choice guard", () => {
  test("a press within 350 ms of the choice showing is refused and changes nothing; at 350 ms it picks", () => {
    const s = atChoice();
    const gate = createChoiceGate();
    expect(showChoice(gate, s.choice!, 2000)).toBe(true);
    const cards = s.choice;
    for (const at of [2000, 2250, 2349]) {
      expect(pickChoice(gate, s, 0, at)).toBe(false);
      expect(s.choice).toBe(cards);
      expect(s.taken).toEqual([]);
    }
    expect(pickChoice(gate, s, 0, 2350)).toBe(true);
    expect(s.choice).toBeNull();
    expect(s.taken).toEqual([cards![0]!]);
  });

  test("the choice is timed from when it was first shown, not each frame it stays up", () => {
    const s = atChoice();
    const gate = createChoiceGate();
    expect(showChoice(gate, s.choice!, 2000)).toBe(true);
    expect(showChoice(gate, s.choice!, 2300)).toBe(false);
    expect(pickChoice(gate, s, 0, 2350)).toBe(true);
  });

  test("a choice not yet shown can't be picked", () => {
    const s = atChoice();
    expect(pickChoice(createChoiceGate(), s, 0, 1e9)).toBe(false);
    expect(s.choice).not.toBeNull();
  });

  test("the next choice starts its own 350 ms", () => {
    const s = atChoice();
    const gate = createChoiceGate();
    showChoice(gate, s.choice!, 2000);
    expect(pickChoice(gate, s, 0, 2400)).toBe(true);
    while (!s.choice && s.time < 2 * CHOICE_EVERY + 1) {
      step(s, { kind: "none" }, DT);
      s.hits = 0;
    }
    expect(s.choice).not.toBeNull();
    expect(showChoice(gate, s.choice!, 30000)).toBe(true);
    expect(pickChoice(gate, s, 0, 30349)).toBe(false);
    expect(pickChoice(gate, s, 0, 30350)).toBe(true);
  });
});
