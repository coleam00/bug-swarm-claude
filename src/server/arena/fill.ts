// Fill bots (#66), the pure part: their names, their team, and how many an arena should gain or
// lose. room.ts does the rest. Every name carries the `bot ` prefix that `/ws` refuses from
// clients (rules.ts isBotName), so in the arena a `bot ` name is always a server bot.
import { TEAMS, type Team } from "../rules";

/** The fill bots' names, used in order: the first one not already in the arena. */
export const FILL_BOT_NAMES = [
  "bot Ada",
  "bot Linus",
  "bot Grace",
  "bot Alan",
  "bot Margaret",
  "bot Ken",
  "bot Barbara",
  "bot Dennis",
  "bot Edsger",
  "bot Hedy",
  "bot Donald",
  "bot Frances",
  "bot Guido",
  "bot Radia",
  "bot Bjarne",
  "bot Katherine",
  "bot Tim",
  "bot Anders",
  "bot Sophie",
  "bot John",
] as const;

/** The first fill-bot name nobody in the arena has (the arena holds at most 20, so one is free). */
export function botName(inUse: (name: string) => boolean): string {
  for (const n of FILL_BOT_NAMES) if (!inUse(n)) return n;
  return FILL_BOT_NAMES[0];
}

/** The team with fewer players in the arena (ties: tabs), so bots even the teams out. */
export function botTeam(players: readonly { team: Team }[]): Team {
  const [tabs, spaces] = TEAMS;
  let n = 0;
  for (const p of players) n += p.team === tabs ? 1 : -1;
  return n > 0 ? spaces : tabs;
}

/**
 * How many players (people plus bots) an arena should hold: `fillTo` while people play in it;
 * `demoTo` while nobody plays but someone watches (the start screen's demo arena, #79); else 0
 * (it is closing).
 */
export function botTarget(people: number, watchers: number, fillTo: number, demoTo: number): number {
  if (people > 0) return fillTo;
  return watchers > 0 ? demoTo : 0;
}

/**
 * How many bots an arena with `people` and `bots` should gain (above 0) or lose (below 0) to
 * reach `target` players (botTarget). A target of 0 manages nothing.
 */
export function fillDelta(people: number, bots: number, target: number): number {
  if (target <= 0) return 0;
  const total = people + bots;
  if (total < target) return target - total;
  const retire = Math.min(bots, total - target);
  return retire > 0 ? -retire : 0;
}
