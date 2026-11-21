import { describe, expect, test } from "bun:test";
import { BUG_LOOK_IDS, BUG_LOOKS, PALETTE, ROBOT_HALO_RADIUS, ROBOT_MARK, ROBOT_MARK_OUTLINE_WIDTH, ROBOT_MARK_RADIUS, ROBOT_RIM } from "./look";
import { BUG_KINDS, ROBOT_RADIUS } from "./config";

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

  test("every bug kind has a look drawn at its size", () => {
    expect([...BUG_LOOK_IDS].sort()).toEqual(BUG_KINDS.map((k) => k.id).sort());
    for (const k of BUG_KINDS) expect(BUG_LOOKS[k.id].radius).toBe(k.radius);
  });
});

describe("your robot's marker", () => {
  const markOuter = ROBOT_MARK_RADIUS + ROBOT_MARK_OUTLINE_WIDTH / 2;

  test("the marker ring sits outside the body and inside the halo", () => {
    expect(ROBOT_MARK_RADIUS - ROBOT_MARK_OUTLINE_WIDTH / 2).toBeGreaterThan(ROBOT_RADIUS);
    expect(ROBOT_HALO_RADIUS).toBeGreaterThan(markOuter);
  });

  test("the marker and the robot's rim are different colours", () => {
    expect(ROBOT_MARK).not.toBe(ROBOT_RIM);
  });
});
