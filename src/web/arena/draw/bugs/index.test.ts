// Every bug kind reaches the screen (#65): BUG_DRAW has a look and a draw for each id.
import { describe, expect, test } from "bun:test";
import { BUG_KINDS } from "../../../../shared/arena/constants";
import { PALETTE } from "../../../game/look";
import { BUG_DRAW } from "./index";

describe("bug draws", () => {
  test("every id in BUG_KINDS has a draw function and a look whose glow is a palette colour", () => {
    expect(Object.keys(BUG_DRAW).sort()).toEqual([...BUG_KINDS].sort());
    for (const k of BUG_KINDS) {
      const d = BUG_DRAW[k];
      expect(typeof d.draw).toBe("function");
      expect(d.look.radius).toBeGreaterThan(0);
      expect(PALETTE[d.look.glow]).toBeDefined();
    }
  });
});
