import { describe, expect, test } from "bun:test";
import { SHELL_HALF, beetle } from "../../../../shared/arena/bugs/beetle";
import { SHOT_RADIUS } from "../../../../shared/arena/constants";
import { BODY_REACH, RIM_RADIUS, beetleRim } from "./beetle";

describe("beetle look (#80)", () => {
  test("the rim spans exactly the shell: SHELL_HALF either side of its facing, the arc the simulation blocks", () => {
    const r = beetleRim(1, { start: 0, end: 0 });
    expect(r.start).toBeCloseTo(1 - SHELL_HALF, 9);
    expect(r.end).toBeCloseTo(1 + SHELL_HALF, 9);
    expect(Math.cos(SHELL_HALF)).toBeCloseTo(beetle.shell!.cosHalf, 9);
    expect(((r.end - r.start) * 180) / Math.PI).toBeCloseTo(120, 9);
  });

  test("the rim is drawn on the circle shots meet, and the body inside it", () => {
    const hit = beetle.radius + SHOT_RADIUS;
    expect(RIM_RADIUS).toBeCloseTo(hit, 6);
    expect(BODY_REACH).toBeLessThanOrEqual(hit + 1e-6);
    // A drawing much smaller than the body the simulation hits (say half size) fails here.
    expect(BODY_REACH).toBeGreaterThan(beetle.radius * 0.75);
  });
});
