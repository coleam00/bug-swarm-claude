import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TEAMS } from "../../server/rules";
import { TEAM_LOOK } from "../teams";
import { boardView, joinText, parseBoard, type Board } from "./data";

const [TABS, SPACES] = TEAMS;
const board = (names: [string, number][], tabs = 0, spaces = 0): Board => ({
  top: names.map(([name, score]) => ({ name, score })),
  teams: { tabs, spaces },
});

describe("parseBoard", () => {
  test("takes a well-formed body and copies only the fields the board uses", () => {
    const body = { top: [{ name: "Ann", score: 50, extra: 1 }], teams: { tabs: 70, spaces: 30, nobody: 5 }, more: true };
    expect(parseBoard(body)).toEqual({ top: [{ name: "Ann", score: 50 }], teams: { tabs: 70, spaces: 30 } });
    expect(parseBoard({ top: [], teams: { tabs: 0, spaces: 0 } })).toEqual(board([]));
  });

  test("refuses anything else", () => {
    const ok = { top: [{ name: "Ann", score: 50 }], teams: { tabs: 1, spaces: 2 } };
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
    ]) {
      expect(parseBoard(bad)).toBeNull();
    }
  });

  test("a name that looks like HTML passes through as the same plain string", () => {
    const name = '<img src=x onerror="alert(1)">';
    const b = parseBoard({ top: [{ name, score: 1 }], teams: { tabs: 0, spaces: 0 } })!;
    expect(b.top[0]!.name).toBe(name);
    expect(boardView(null, b).rows[0]!.name).toBe(name);
  });
});

describe("boardView rows", () => {
  test("ranks from 1 and formats scores with thousands separators", () => {
    const v = boardView(null, board([["Ann", 1234567], ["Bob", 0]]));
    expect(v.rows).toEqual([
      { rank: 1, name: "Ann", score: "1,234,567", isNew: false },
      { rank: 2, name: "Bob", score: "0", isNew: false },
    ]);
  });

  test("the first load highlights nothing", () => {
    expect(boardView(null, board([["Ann", 5], ["Bob", 4]])).rows.some((r) => r.isNew)).toBe(false);
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

test("joinText names the page's own host, without protocol or slash", () => {
  expect(joinText("http://localhost:5173")).toBe("Play at localhost:5173");
  expect(joinText("https://x.example.com/")).toBe("Play at x.example.com");
});

test("the board's DOM code never writes HTML, so names always render as text", () => {
  for (const file of ["view.ts", "main.ts"]) {
    const src = readFileSync(join(import.meta.dir, file), "utf8");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      expect(src.includes(sink)).toBe(false);
    }
  }
});
