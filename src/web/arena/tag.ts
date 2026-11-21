// The name tag of a server fill bot (#66): a small "BOT" pill just left of its name, which is drawn
// dimmer than a person's. A bot is told by its name: only the server may use the `bot ` prefix
// (rules.ts isBotName), so the protocol carries no flag. Pure: render.ts measures the text once
// per robot and keeps the box here on the robot.
import { isBotName } from "../../server/rules";

export const BOT_TAG = "BOT";
/** Space between the pill's text and its edge, px. */
export const BOT_TAG_PAD = 3;
/** Space between the pill and the name, px. */
export const BOT_TAG_GAP = 4;

/** Where a robot's BOT pill goes, relative to its centred name: left edge `x` and width `w` (0: no pill). */
export type TagBox = { x: number; w: number };

/** Whether a robot named `name` is a server bot, so it gets the pill and the dim name. */
export function isBot(name: string): boolean {
  return isBotName(name);
}

/** The pill's box for a centred name `nameW` wide, whose "BOT" text is `tagW` wide, into `out`. */
export function botTagBox(nameW: number, tagW: number, out: TagBox): TagBox {
  out.w = tagW + 2 * BOT_TAG_PAD;
  out.x = -nameW / 2 - BOT_TAG_GAP - out.w;
  return out;
}
