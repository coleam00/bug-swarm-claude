// The stream board's DOM. Built once, then updated in place, so a refresh never rebuilds or
// flashes the page. Text goes in through textContent only: names are untrusted and are never
// parsed as HTML (engineering.md, "Anything viewers type is untrusted").
import { TEAMS, type Team } from "../../server/rules";
import { TEAM_LOOK } from "../teams";
import { TOP_SIZE, arenaPills, nameScale, type BoardView, type LiveArena } from "./data";
import type { BoardStatus } from "./poll";

const EMPTY = "-";

type RowEls = { root: HTMLElement; name: HTMLElement; score: HTMLElement };
type TeamEls = { root: HTMLElement; total: HTMLElement; bar: HTMLElement };
/** An arena pill: its text, and the hive queen's part (a pulsing mark and her health), hidden with no queen (#102). */
type PillEls = { root: HTMLElement; label: HTMLElement; queen: HTMLElement; queenText: HTMLElement };

export type BoardDom = {
  render(view: BoardView): void;
  setStatus(status: BoardStatus): void;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Restarts the short highlight on an element, even if it is still running from last time. */
function flash(e: HTMLElement): void {
  e.classList.remove("flash");
  void e.offsetWidth; // force a reflow so the animation starts again
  e.classList.add("flash");
}

/**
 * Shrinks a name that is too wide for its row so the whole name shows, down to the floor
 * (NAME_MIN_SCALE); past that the CSS ellipsis cuts it. Measured at full size first; text width
 * scales with the font size, and the 1 px margin keeps rounding from tripping the ellipsis.
 */
function fitName(e: HTMLElement): void {
  e.style.fontSize = "";
  const natural = e.scrollWidth;
  const available = e.clientWidth - 1;
  const scale = nameScale(available, natural);
  if (scale < 1) e.style.fontSize = `${scale}em`;
}

/** Draws the whole frame at once (empty slots, no totals yet), so the page is never blank. */
export function createBoardDom(root: HTMLElement, host: string[]): BoardDom {
  const top = el("ol", "top");
  const rows: RowEls[] = [];
  for (let i = 0; i < TOP_SIZE; i++) {
    const li = el("li", "row empty");
    const name = el("span", "name", EMPTY);
    const score = el("span", "score");
    li.append(el("span", "rank", String(i + 1)), name, score);
    top.append(li);
    rows.push({ root: li, name, score });
  }

  const race = el("section", "race");
  const teamsBox = el("div", "teams");
  const bar = el("div", "bar");
  const teams = {} as Record<Team, TeamEls>;
  for (const team of TEAMS) {
    const look = TEAM_LOOK[team];
    const block = el("div", "team");
    block.style.setProperty("--team", look.color);
    const total = el("span", "team-total", EMPTY);
    block.append(el("span", "team-label", look.label), total);
    teamsBox.append(block);
    const seg = el("span", "bar-seg");
    seg.style.background = look.color;
    seg.style.flexGrow = "1";
    bar.append(seg);
    teams[team] = { root: block, total, bar: seg };
  }
  // The address to join: each piece unbreakable, with a break allowed only between pieces (after a dot).
  const join = el("p", "join");
  const address = el("span", "join-host");
  for (const part of host) address.append(el("span", "join-part", part), document.createElement("wbr"));
  join.append(el("span", "join-label", "Play at"), address);
  // People playing now (never bots), under the title.
  const live = el("p", "live");
  const liveCount = el("span", "live-count", EMPTY);
  live.append(liveCount, el("span", "live-label", "playing now"));
  race.append(el("h1", "title", "Bug Swarm"), live, el("p", "race-title", "Tabs vs Spaces"), teamsBox, bar, join);

  // The arena strip across the bottom: one pill per open arena while they fit on its line, else as
  // many as fit with the last chip '+N more' (fitPills). A note while no arena is open, so the strip
  // never collapses. Pills are made as needed and kept, children and all, so the queen's pulse
  // (#102) never restarts on a poll.
  const strip = el("ul", "arenas");
  const pills: PillEls[] = [];
  const none = el("li", "pill empty-note", "No arenas open");
  strip.append(none);
  let arenas: LiveArena[] = [];

  /** Shows `slots` chips' worth of the arenas. */
  const showPills = (slots: number): void => {
    const { pills: shown, more } = arenaPills(arenas, slots);
    while (pills.length < shown.length + 1) {
      const li = el("li", "pill");
      const label = el("span", "pill-label");
      const queen = el("span", "pill-queen", " · ");
      const queenText = el("span", "queen-text");
      queen.append(el("span", "queen-mark"), queenText);
      queen.hidden = true;
      li.append(label, queen);
      strip.insertBefore(li, none);
      pills.push({ root: li, label, queen, queenText });
    }
    pills.forEach((pill, i) => {
      const p = shown[i];
      const isMore = !p && more > 0 && i === shown.length;
      pill.root.hidden = !p && !isMore;
      pill.root.classList.toggle("more", isMore);
      pill.label.textContent = p ? p.text : isMore ? `+${more} more` : "";
      pill.queen.hidden = !p?.queen;
      pill.queenText.textContent = p?.queen ?? "";
    });
    none.hidden = shown.length > 0 || more > 0;
  };
  /**
   * Every arena if their pills fit the strip's width, else the most chips that fit, '+N more'
   * included: measured, like fitName, since pill widths grow with arena ids and waves over a stream.
   * Where the strip wraps (portrait) everything fits.
   */
  const fitPills = (): void => {
    for (let slots = arenas.length; slots > 1; slots--) {
      showPills(slots);
      if (strip.scrollWidth <= strip.clientWidth) return;
    }
    showPills(Math.min(1, arenas.length));
  };

  const status = el("p", "status", "reconnecting...");
  status.hidden = true;
  root.replaceChildren(top, race, strip, status);
  // The stream frame can change size; names are fitted again to the new width.
  addEventListener("resize", () => {
    rows.forEach((r) => fitName(r.name));
    fitPills();
  });

  return {
    render(view) {
      rows.forEach((r, i) => {
        const row = view.rows[i];
        r.root.classList.toggle("empty", !row);
        r.name.textContent = row ? row.name : EMPTY;
        r.score.textContent = row ? row.score : "";
        fitName(r.name); // after the score: its width sets the room the name has
        if (row?.isNew) flash(r.root);
      });
      for (const t of view.teams) {
        const els = teams[t.team];
        els.total.textContent = t.total;
        els.bar.style.flexGrow = String(t.share);
        els.root.classList.toggle("ahead", view.leader === t.team);
      }
      if (view.overtook && view.leader) flash(teams[view.leader].root);

      liveCount.textContent = view.playing;
      arenas = view.arenas;
      fitPills();
    },
    setStatus(s) {
      status.hidden = s === "live";
    },
  };
}
