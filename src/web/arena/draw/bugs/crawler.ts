// The crawler (#55): release 1's base beetle, walking at whoever is nearest.
import { BUG_LOOKS } from "../../../game/look";
import { drawBody } from "./body";
import type { BugDraw } from "./kind";

const look = BUG_LOOKS.base;

export const crawlerDraw: BugDraw = {
  look,
  draw: (f, view, i) => drawBody(f, look, view, i),
};
