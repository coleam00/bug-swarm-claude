import { describe, expect, test } from "bun:test";
import { BUG_LOOK_IDS, BUG_LOOKS, PALETTE, bugLookId } from "./look";
import { BUG_RADIUS, createState, step } from "./sim";

describe("bug looks", () => {
  test("every look has a size, a palette glow and moving legs", () => {
    for (const id of BUG_LOOK_IDS) {
      const look = BUG_LOOKS[id];
      expect(look.radius).toBeGreaterThan(0);
      expect(PALETTE[look.glow]).toBeDefined();
      expect(look.legHz).toBeGreaterThan(0);
      expect(look.legSwing).toBeGreaterThan(0);
    }
  });

  test("the fast bug is smaller, quicker-legged and twitchier than the basic one", () => {
    expect(BUG_LOOKS.fast.radius).toBeLessThan(BUG_LOOKS.basic.radius);
    expect(BUG_LOOKS.fast.legHz).toBeGreaterThan(BUG_LOOKS.basic.legHz);
    expect(BUG_LOOKS.fast.jitter).toBeGreaterThan(BUG_LOOKS.basic.jitter);
    expect(BUG_LOOKS.fast.glow).not.toBe(BUG_LOOKS.basic.glow);
  });

  test("every bug the sim spawns has a look drawn at its size", () => {
    const s = createState(1, { w: 600, h: 1100 });
    for (let i = 0; i < 120; i++) step(s, { kind: "none" }, 1 / 60);
    expect(s.bugs.length).toBeGreaterThan(0);
    for (const b of s.bugs) expect(BUG_LOOKS[bugLookId(b)].radius).toBe(BUG_RADIUS);
  });
});
