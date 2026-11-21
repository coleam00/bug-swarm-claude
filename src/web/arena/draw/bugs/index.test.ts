// Every bug kind's look can be drawn (#65): a positive size and a glow the palette has. (That each
// id has an entry and a draw function, tsc checks: BUG_DRAW is a Record over BUG_KINDS.)
import { describe, expect, test } from "bun:test";
import { BUG_KINDS } from "../../../../shared/arena/constants";
import { PALETTE } from "../../../game/look";
import { BUG_DRAW } from "./index";

describe("bug draws", () => {
  test("every kind's look has a positive radius and a glow that is a palette colour", () => {
    for (const k of BUG_KINDS) {
      const d = BUG_DRAW[k];
      expect(d.look.radius).toBeGreaterThan(0);
      expect(PALETTE[d.look.glow]).toBeDefined();
    }
  });
});
