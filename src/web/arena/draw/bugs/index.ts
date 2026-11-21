// Every bug kind's look and draw functions, by kind id (#65). The Record makes TypeScript demand an
// entry for each id in BUG_KINDS, so no kind reaches the screen undrawn.
import type { BugKind } from "../../../../shared/arena/constants";
import { crawlerDraw } from "./crawler";
import { dasherDraw } from "./dasher";
import { globDraw } from "./glob";
import type { BugDraw } from "./kind";
import { spitterDraw } from "./spitter";

export const BUG_DRAW: Record<BugKind, BugDraw> = { crawler: crawlerDraw, dasher: dasherDraw, spitter: spitterDraw, glob: globDraw };
