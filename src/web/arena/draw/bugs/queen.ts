// The hive queen (#85): a big beetle in royal amber. Filled out with her tell in the browser commit.
import { QUEEN_RADIUS } from "../../../../shared/arena/bugs/queen";
import { GLOW_QUEEN, type BugLook } from "../../../game/look";
import { drawBody } from "./body";
import type { BugDraw } from "./kind";

const look: BugLook = {
  radius: QUEEN_RADIUS + 12,
  shell: "#7c2d12",
  shine: "#ffb020",
  head: "#2a0a04",
  legs: "#ffd98a",
  glow: GLOW_QUEEN,
  legHz: 0.8,
  legSwing: 0.25,
  jitter: 0.02,
  jitterHz: 0.3,
};

export const queenDraw: BugDraw = { look, draw: (f, view, i) => drawBody(f, look, view, i) };
