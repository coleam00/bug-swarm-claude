// The name tag of a server fill bot (#66): a small "BOT" pill just left of its name, which is drawn
// dimmer than a person's. A bot is told by its name: only the server may use a name whose
// first word reads "bot" (rules.ts isBotName), so the protocol carries no flag. Pure: render.ts measures the text once
// per robot and keeps the box here on the robot. Also: who counts as a person in the HUD's
// "N playing" (#90), and where a name tag and HELP go so they never sit under the HUD band (#90).
import { PLAYER_RADIUS } from "../../shared/arena/constants";
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

/**
 * The people among `robots`, bots never counted (#90): the HUD's "N playing" (and the phone's
 * person glyph) counts every person on your arena's roster, you included. Unlike /board (Room.people,
 * #117) it also counts people who are out for 30 s or have the tab hidden.
 */
export function countPeople(robots: Iterable<{ bot: boolean }>): number {
  let n = 0;
  for (const r of robots) if (!r.bot) n++;
  return n;
}

/** The name tag's baseline above the robot's centre, world units. */
export const NAME_ABOVE = PLAYER_RADIUS * 1.9;
/** HELP's baseline above the name's, world units (#59). */
export const HELP_OVER_NAME = 16;
/** HELP's baseline above the robot's centre: over the name tag. */
export const HELP_ABOVE = NAME_ABOVE + HELP_OVER_NAME;
/** How far the name's text (render.ts NAME_FONT, 13 units, stroked) rises above its baseline, world units. */
export const NAME_ASCENT = 11;
/** How far HELP's text (HELP_FONT, 15 units, pulsing up to 1.18x) rises above its baseline, world units. */
export const HELP_ASCENT = 15;
/** Flipped under the robot: the name's top this far below the robot's centre (mirroring NAME_ABOVE). */
export const NAME_BELOW = NAME_ABOVE;
/** Flipped, HELP's baseline sits this far under the name's. */
export const HELP_UNDER_NAME = HELP_ASCENT + 4;

/** Where a robot's name and HELP go: their baselines, world units. */
export type TagSpot = { name: number; help: number };

/**
 * Where a robot at `robotY` draws its name tag and HELP (only drawn while it is down), into `out`,
 * so neither sits under the HUD band, whose bottom is `bandBottom` (world units; -Infinity: no
 * band). Over the robot as always while the tag's top (HELP's, when `down`) clears the band.
 * Otherwise both flip under the robot, the name first, and never above the band's bottom.
 */
export function tagBaselines(robotY: number, bandBottom: number, down: boolean, out: TagSpot): TagSpot {
  const name = robotY - NAME_ABOVE;
  const help = robotY - HELP_ABOVE;
  const top = down ? help - HELP_ASCENT : name - NAME_ASCENT;
  if (top >= bandBottom) {
    out.name = name;
    out.help = help;
    return out;
  }
  out.name = Math.max(robotY + NAME_BELOW + NAME_ASCENT, bandBottom + NAME_ASCENT);
  out.help = out.name + HELP_UNDER_NAME;
  return out;
}
