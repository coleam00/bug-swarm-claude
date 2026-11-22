import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEAMS } from "../../server/rules";
import { TEAM_LOOK } from "../teams";
import { NAME_MIN_SCALE, arenaPills, boardView, joinHost, nameScale, parseBoard, type Board, type LiveArena } from "./data";

const [TABS, SPACES] = TEAMS;
const board = (names: [string, number][], tabs = 0, spaces = 0): Board => ({
  top: names.map(([name, score]) => ({ name, score })),
  teams: { tabs, spaces },
  playing: 0,
  arenas: [],
});

describe("parseBoard", () => {
  test("takes a well-formed body and copies only the fields the board uses", () => {
    const body = {
      top: [{ name: "Ann", score: 50, extra: 1 }],
      teams: { tabs: 70, spaces: 30, nobody: 5 },
      more: true,
      playing: 15,
      arenas: [{ id: 3, players: 14, wave: 7, bots: 6, queen: 64 }, { id: 4, players: 1, wave: 1, queen: null }, { id: 5, players: 2, wave: 2 }],
    };
    expect(parseBoard(body)).toEqual({
      top: [{ name: "Ann", score: 50 }],
      teams: { tabs: 70, spaces: 30 },
      playing: 15,
      // A missing queen (an older server) reads as none.
      arenas: [{ id: 3, players: 14, wave: 7, queen: 64 }, { id: 4, players: 1, wave: 1, queen: null }, { id: 5, players: 2, wave: 2, queen: null }],
    });
    for (const queen of [1, 100]) expect(parseBoard({ ...body, arenas: [{ id: 1, players: 1, wave: 5, queen }] })?.arenas[0]!.queen).toBe(queen);
    expect(parseBoard({ top: [], teams: { tabs: 0, spaces: 0 }, playing: 0, arenas: [] })).toEqual(board([]));
    // No cap on how many arenas are open.
    const many = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, players: 20, wave: 999 }));
    expect(parseBoard({ top: [], teams: { tabs: 0, spaces: 0 }, playing: 800, arenas: many })?.arenas.length).toBe(40);
  });

  test("refuses anything else", () => {
    const ok = { top: [{ name: "Ann", score: 50 }], teams: { tabs: 1, spaces: 2 }, playing: 1, arenas: [{ id: 1, players: 1, wave: 1 }] };
    const arena = ok.arenas[0]!;
    expect(parseBoard(ok)).not.toBeNull();
    for (const bad of [
      null,
      "board",
      [],
      { ...ok, top: undefined },
      { ...ok, teams: { tabs: 1 } }, // a team missing
      { ...ok, teams: { tabs: 1, spaces: "2" } },
      { ...ok, teams: { tabs: 1, spaces: Number.NaN } },
      { ...ok, top: [{ name: "Ann", score: "50" }] }, // a string score
      { ...ok, top: [{ name: 7, score: 50 }] },
      { ...ok, top: [null] },
      { ...ok, top: Array.from({ length: 11 }, (_, i) => ({ name: `P${i}`, score: i })) }, // 11 rows
      { ...ok, playing: undefined },
      { ...ok, arenas: undefined },
      { ...ok, playing: -1 },
      { ...ok, playing: 1.5 },
      { ...ok, playing: "1" },
      { ...ok, arenas: {} },
      { ...ok, arenas: [null] },
      { ...ok, arenas: [{ ...arena, id: 0 }] },
      { ...ok, arenas: [{ ...arena, wave: 0 }] },
      { ...ok, arenas: [{ ...arena, players: -1 }] },
      { ...ok, arenas: [{ ...arena, players: "1" }] },
      { ...ok, arenas: [{ ...arena, wave: 2.5 }] },
      // A queen's health is a whole percent from 1 to 100 (#102).
      { ...ok, arenas: [{ ...arena, queen: 0 }] },
      { ...ok, arenas: [{ ...arena, queen: 101 }] },
      { ...ok, arenas: [{ ...arena, queen: 64.5 }] },
      { ...ok, arenas: [{ ...arena, queen: "64" }] },
      { ...ok, arenas: [{ ...arena, queen: true }] },
    ]) {
      expect(parseBoard(bad)).toBeNull();
    }
  });

  test("a name that looks like HTML passes through as the same plain string", () => {
    const name = '<img src=x onerror="alert(1)">';
    const b = parseBoard({ top: [{ name, score: 1 }], teams: { tabs: 0, spaces: 0 }, playing: 0, arenas: [] })!;
    expect(b.top[0]!.name).toBe(name);
    expect(boardView(null, b).rows[0]!.name).toBe(name);
  });
});

describe("boardView rows", () => {
  test("ranks from 1, formats scores with thousands separators, and highlights nothing on the first load", () => {
    const v = boardView(null, board([["Ann", 1234567], ["Bob", 0]]));
    expect(v.rows).toEqual([
      { rank: 1, name: "Ann", score: "1,234,567", isNew: false },
      { rank: 2, name: "Bob", score: "0", isNew: false },
    ]);
  });

  test("a new name is new; a name moving rank is not", () => {
    const prev = board([["Ann", 50], ["Bob", 40]]);
    const v = boardView(prev, board([["Bob", 60], ["Cat", 55], ["Ann", 50]]));
    expect(v.rows.map((r) => [r.name, r.isNew])).toEqual([
      ["Bob", false],
      ["Cat", true],
      ["Ann", false],
    ]);
  });

  test("two players with the same name: only the extra row is new", () => {
    const v = boardView(board([["bob", 50]]), board([["bob", 60], ["bob", 50]]));
    expect(v.rows.filter((r) => r.isNew).length).toBe(1);
    expect(v.rows[1]!.isNew).toBe(true);
  });

  test("a name that dropped out and comes back is new again", () => {
    const first = board([["Ann", 50]]);
    const second = board([["Bob", 60]]);
    expect(boardView(first, second).rows[0]!.isNew).toBe(true);
    expect(boardView(second, board([["Bob", 60], ["Ann", 50]])).rows[1]!.isNew).toBe(true);
  });

  test("the same board twice highlights nothing", () => {
    const b = board([["Ann", 50], ["Bob", 40]]);
    expect(boardView(b, b).rows.some((r) => r.isNew)).toBe(false);
  });
});

describe("boardView teams", () => {
  test("each team has its label, colour, total and share", () => {
    const v = boardView(null, board([], 3000, 1000));
    expect(v.teams).toEqual([
      { team: TABS, label: TEAM_LOOK.tabs.label, color: TEAM_LOOK.tabs.color, total: "3,000", share: 0.75 },
      { team: SPACES, label: TEAM_LOOK.spaces.label, color: TEAM_LOOK.spaces.color, total: "1,000", share: 0.25 },
    ]);
  });

  test("zero totals split the race bar 50/50 with no leader", () => {
    const v = boardView(null, board([], 0, 0));
    expect(v.teams.map((t) => t.share)).toEqual([0.5, 0.5]);
    expect(v.leader).toBeNull();
  });

  test("the leader is the team strictly ahead; a tie has none", () => {
    expect(boardView(null, board([], 10, 5)).leader).toBe(TABS);
    expect(boardView(null, board([], 5, 10)).leader).toBe(SPACES);
    expect(boardView(null, board([], 7, 7)).leader).toBeNull();
  });

  test("an overtake is flagged both ways", () => {
    expect(boardView(board([], 10, 5), board([], 10, 11)).overtook).toBe(true);
    expect(boardView(board([], 5, 10), board([], 12, 10)).overtook).toBe(true);
  });

  test("no overtake on the first load, when the leader holds, from a tie, or into a tie", () => {
    expect(boardView(null, board([], 10, 5)).overtook).toBe(false);
    expect(boardView(board([], 10, 5), board([], 20, 5)).overtook).toBe(false);
    expect(boardView(board([], 5, 5), board([], 6, 5)).overtook).toBe(false);
    expect(boardView(board([], 10, 5), board([], 10, 10)).overtook).toBe(false);
  });
});

test("nameScale: a name that fits keeps its size; a wider one shrinks to fit, down to 36 px of a 57.6 px row", () => {
  expect(nameScale(300, 300)).toBe(1);
  expect(nameScale(300, 120)).toBe(1);
  expect(nameScale(300, 400)).toBe(0.75);
  expect(nameScale(300, 600)).toBe(NAME_MIN_SCALE); // 0.5 would be under the floor: the ellipsis takes over
  expect(57.6 * NAME_MIN_SCALE).toBeCloseTo(36);
  expect(nameScale(300, 0)).toBe(1);
});

test("joinHost names the page's own host, without protocol or slash, split after each dot", () => {
  expect(joinHost("http://localhost:5173")).toEqual(["localhost:5173"]);
  expect(joinHost("https://x.example.com/")).toEqual(["x.", "example.", "com"]);
  // Never at a hyphen: viewers might type the break.
  expect(joinHost("https://bug-swarm-claude-production.up.railway.app")).toEqual(["bug-swarm-claude-production.", "up.", "railway.", "app"]);
});

test("the board's DOM code never writes HTML, so names always render as text", () => {
  for (const file of ["view.ts", "main.ts"]) {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(src.includes(sink)).toBe(false);
    }
  }
});

describe("playing now and the arena pills (#74)", () => {
  const arenas = (n: number): LiveArena[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, players: 20, wave: 3, queen: null }));

  test("the count is formatted like scores", () => {
    expect(boardView(null, { ...board([]), playing: 1234 }).playing).toBe("1,234");
    expect(boardView(null, board([])).playing).toBe("0");
  });

  test("one pill per arena, reading 'Arena <id> · <people> · wave <wave>', by id", () => {
    expect(arenaPills([], 4)).toEqual({ pills: [], more: 0, moreQueens: null });
    expect(arenaPills([{ id: 3, players: 14, wave: 7, queen: null }], 4)).toEqual({ pills: [{ id: 3, text: "Arena 3 · 14 · wave 7", queen: null }], more: 0, moreQueens: null });
    expect(arenaPills([{ id: 5, players: 1, wave: 1, queen: null }, { id: 2, players: 20, wave: 4, queen: null }], 4).pills.map((p) => p.id)).toEqual([2, 5]);
  });

  test("an arena with a hive queen alive adds 'QUEEN <health>%'; the others add nothing (#102)", () => {
    const { pills, more } = arenaPills(
      [
        { id: 2, players: 12, wave: 10, queen: 64 },
        { id: 3, players: 4, wave: 9, queen: null },
      ],
      4,
    );
    expect(pills).toEqual([
      { id: 2, text: "Arena 2 · 12 · wave 10", queen: "QUEEN 64%" },
      { id: 3, text: "Arena 3 · 4 · wave 9", queen: null },
    ]);
    expect(more).toBe(0);
  });

  test("'+N more' counts the folded arenas with a queen alive, '1 QUEEN' or 'N QUEENS'; order and count stay by id (owner ruling on #102)", () => {
    const withQueens = (ids: number[]) => arenas(6).map((a) => ({ ...a, queen: ids.includes(a.id) ? 50 : null }));
    // Slots 4: arenas 1-3 shown, 4-6 folded.
    const two = arenaPills(withQueens([2, 4, 6]), 4);
    expect(two.pills.map((p) => [p.id, p.queen])).toEqual([[1, null], [2, "QUEEN 50%"], [3, null]]);
    expect([two.more, two.moreQueens]).toEqual([3, "2 QUEENS"]);
    expect(arenaPills(withQueens([5]), 4).moreQueens).toBe("1 QUEEN");
    // Queens only among the shown pills, or none folded at all: nothing on the chip.
    expect(arenaPills(withQueens([1, 2, 3]), 4).moreQueens).toBeNull();
    expect(arenaPills(withQueens([1, 6]), 6)).toMatchObject({ more: 0, moreQueens: null });
    // Every arena folded (slots 1).
    expect(arenaPills(withQueens([1, 2, 3, 4, 5, 6]), 1)).toMatchObject({ pills: [], more: 6, moreQueens: "6 QUEENS" });
  });

  test("up to the slots, every arena shows; past them the last slot is '+N more' for the rest", () => {
    const all = arenaPills(arenas(4), 4);
    expect(all.pills.length).toBe(4);
    expect(all.more).toBe(0);
    const over = arenaPills(arenas(5), 4);
    expect(over.pills.map((p) => p.id)).toEqual([1, 2, 3]);
    expect(over.more).toBe(2);
    const fifteen = arenaPills(arenas(15), 11);
    expect(fifteen.pills.length).toBe(10);
    expect(fifteen.more).toBe(5);
    expect(arenaPills(arenas(15), 1)).toEqual({ pills: [], more: 15, moreQueens: null });
  });
});
