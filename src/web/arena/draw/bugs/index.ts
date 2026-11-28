// Every bug kind's look and draw functions, by kind id (#65). The Record makes TypeScript demand an
// entry for each id in BUG_KINDS, so no kind reaches the screen undrawn.
import type { BugKind } from "../../../../shared/arena/constants";
import { beetleDraw } from "./beetle";
import { crawlerDraw } from "./crawler";
import { dasherDraw } from "./dasher";
import { globDraw } from "./glob";
import { goldenDraw } from "./golden";
import type { BugDraw } from "./kind";
import { queenDraw } from "./queen";
import { spitterDraw } from "./spitter";

export const BUG_DRAW: Record<BugKind, BugDraw> = { crawler: crawlerDraw, dasher: dasherDraw, spitter: spitterDraw, glob: globDraw, beetle: beetleDraw, queen: queenDraw, golden: goldenDraw };
