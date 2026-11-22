import { describe, expect, test } from "bun:test";
import { SHELL_HALF, beetle } from "../../../../shared/arena/bugs/beetle";
import { beetleRim } from "./beetle";

describe("beetle look (#80)", () => {
  test("the rim spans exactly the shell: SHELL_HALF either side of its facing, the arc the simulation blocks", () => {
    const r = beetleRim(1, { start: 0, end: 0 });
    expect(r.start).toBeCloseTo(1 - SHELL_HALF, 9);
    expect(r.end).toBeCloseTo(1 + SHELL_HALF, 9);
    expect(Math.cos(SHELL_HALF)).toBeCloseTo(beetle.shell!.cosHalf, 9);
    expect(((r.end - r.start) * 180) / Math.PI).toBeCloseTo(120, 9);
  });
});
