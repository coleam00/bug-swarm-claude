import { describe, expect, test } from "bun:test";
import { BUG_LOOK_IDS, BUG_LOOKS, PALETTE, bugLookId } from "./look";
import { BUG_KINDS } from "./config";
import { choose, createState, step } from "./sim";

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
    expect(BUG_LOOKS.fast.radius).toBeLessThan(BUG_LOOKS.base.radius);
    expect(BUG_LOOKS.fast.legHz).toBeGreaterThan(BUG_LOOKS.base.legHz);
    expect(BUG_LOOKS.fast.jitter).toBeGreaterThan(BUG_LOOKS.base.jitter);
    expect(BUG_LOOKS.fast.glow).not.toBe(BUG_LOOKS.base.glow);
  });

  test("every bug the sim spawns, of every kind, has a look drawn at its size", () => {
    const s = createState(1, { w: 450, h: 800 });
    const seen = new Set<string>();
    for (let i = 0; i < 45 * 60; i++) {
      step(s, { kind: "none" }, 1 / 60);
      if (s.choice) choose(s, 0);
      s.hits = 0; // kept alive past the fast bug's start
      for (const b of s.bugs) {
        seen.add(b.kind.id);
        expect(BUG_LOOKS[bugLookId(b)].radius).toBe(b.kind.radius);
      }
    }
    expect([...seen].sort()).toEqual(BUG_KINDS.map((k) => k.id).sort());
  });
});
