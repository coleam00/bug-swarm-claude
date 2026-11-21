// The dasher policy (#60), called directly on a hand-built observation: it dashes only when ready
// and a bug is about to touch it, and then away from the bug.
import { describe, expect, test } from "bun:test";
import { MAX_BUG_RADIUS } from "./bugs/registry";
import { PLAYER_RADIUS } from "./constants";
import { DASH_CONTACT, createMemory, createObservation, dasher, setObservedBug, type PolicyInput } from "./policies";
import { createRng } from "./rng";

/** The dasher at (1200, 1200), ready or not, with one still bug `gap` units to its right. */
function decide(gap: number, ready = true): PolicyInput {
  const obs = createObservation();
  obs.world.w = 2400;
  obs.world.h = 2400;
  obs.self.x = 1200;
  obs.self.y = 1200;
  obs.self.alive = true;
  obs.self.dashReady = ready;
  setObservedBug(obs, 0, 1200 + gap, 1200, 0, 0);
  obs.bugCount = 1;
  const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
  dasher(obs, createMemory(), createRng(1), out);
  return out;
}

describe("dasher", () => {
  const touching = PLAYER_RADIUS + MAX_BUG_RADIUS;

  test("a bug about to touch it: it dashes, away from the bug", () => {
    const out = decide(touching + DASH_CONTACT - 5);
    expect(out.dash).toBe(true);
    expect(out.mx).toBeLessThan(-0.9);
  });

  test("a bug farther off: no dash", () => {
    expect(decide(touching + DASH_CONTACT + 60).dash).toBe(false);
  });

  test("its dash not ready: no dash, however close the bug", () => {
    expect(decide(touching + 5, false).dash).toBe(false);
  });
});
