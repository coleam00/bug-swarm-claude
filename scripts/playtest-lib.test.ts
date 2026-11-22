import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { INTERP_DELAY_MS, REVIVE_RANGE, WORLD_H, WORLD_W } from "../src/shared/arena/constants";
import type { ServerMessage, SnapshotBug, SnapshotDown, SnapshotKill, SnapshotMe, SnapshotPlayer, SnapshotQueen } from "../src/shared/arena/protocol";
import { checkName, TEAMS } from "../src/server/rules";
import { dashButtonAt, DASH_BUTTON_RADIUS } from "../src/web/arena/controls";
import { STICK_DEAD, STICK_RANGE } from "../src/web/game/stick";
import {
  AFTER_RESTART_S,
  AIM_FINGER,
  BURST_OFF_S,
  BURST_ON_S,
  CONTACT_UNITS,
  DESKTOP,
  LATE_JOIN_WAVE,
  LATE_PLAY_S,
  MOUSE_REACH,
  MOVE_FINGER,
  PHONE,
  QUEEN_NEAR_UNITS,
  QUEEN_WAVE,
  REVIVE_HOLD_UNITS,
  SCENARIOS,
  SCENARIO_NAMES,
  addFrame,
  addSent,
  cameraAt,
  checkDelivery,
  checkEvents,
  checkInput,
  checkKills,
  checkLifeOver,
  checkPositions,
  checkQueenEvent,
  checkQueenPay,
  checkQueenSnapshots,
  checkRoster,
  checkSameArena,
  checkScenarioLateJoin,
  checkScenarioRestart,
  checkScenarioRevive,
  checkScore,
  chromeCandidates,
  connGen,
  createLog,
  createPlan,
  decide,
  exitCode,
  keysMove,
  mouseAt,
  moveKeys,
  pageSpecs,
  parseArgs,
  rosterAt,
  rosterOf,
  runChecks,
  serverEnv,
  shownNumber,
  table,
  touchLayout,
  touchPoints,
  type PageLog,
  type RestartReport,
  type View,
} from "./playtest-lib";

describe("parseArgs", () => {
  test("defaults to 4 players, 90 s, basic, and strips a trailing slash", () => {
    expect(parseArgs(["--url", "http://127.0.0.1:3000/"])).toEqual({ url: "http://127.0.0.1:3000", serve: false, players: 4, seconds: 90, scenario: "basic", chrome: null, headed: false });
  });

  test("takes both flag forms, --headed and a bare --", () => {
    expect(parseArgs(["--", "--url=https://x.test", "--players", "6", "--seconds=30", "--scenario", "revive", "--chrome", "/c", "--headed"])).toEqual({
      url: "https://x.test",
      serve: false,
      players: 6,
      seconds: 30,
      scenario: "revive",
      chrome: "/c",
      headed: true,
    });
  });

  test("--serve instead of --url: the playtest starts its own server; restart needs it (#95)", () => {
    expect(parseArgs(["--serve", "--scenario", "restart"])).toMatchObject({ url: null, serve: true, scenario: "restart" });
    expect(parseArgs(["--serve"]).scenario).toBe("basic");
    expect(() => parseArgs(["--serve", "--url", "http://x"])).toThrow("pick one");
    expect(() => parseArgs(["--url", "http://x", "--scenario", "restart"])).toThrow("restart needs --serve");
    expect(() => parseArgs(["--serve=1"])).toThrow();
    expect(() => parseArgs([])).toThrow("--url or --serve");
  });

  test("queen runs with --url or --serve (#96)", () => {
    expect(parseArgs(["--url", "http://x", "--scenario", "queen"]).scenario).toBe("queen");
    expect(parseArgs(["--serve", "--scenario=queen"])).toMatchObject({ serve: true, scenario: "queen" });
  });

  test("refuses a missing url, unknown flags, unknown scenarios and out-of-range numbers", () => {
    for (const argv of [[], ["--url", "ftp://x"], ["--url", "nope"], ["--url", "http://x", "--players", "1"], ["--url", "http://x", "--players", "21"], ["--url", "http://x", "--seconds", "2.5"], ["--url", "http://x", "--scenario", "chaos"], ["--url", "http://x", "--bots", "3"], ["--url", "http://x", "--headed=1"], ["--url"]]) {
      expect(() => parseArgs(argv)).toThrow();
    }
  });
});

describe("serverEnv", () => {
  test("pins the port, scratch data and build; drops what would change the build, the interface or the wave", () => {
    const env = serverEnv({ PATH: "/bin", RAILWAY_GIT_COMMIT_SHA: "abc", NODE_ENV: "production", BUG_SWARM_START_WAVE: "5", BUILD_ID: "old", PORT: "3000", UNSET: undefined }, 4567, "/tmp/d", "playtest-1");
    expect(env).toEqual({ PATH: "/bin", PORT: "4567", DATA_DIR: "/tmp/d", BUILD_ID: "playtest-1" });
  });

  test("the queen scenario sets BUG_SWARM_START_WAVE to her wave, over an inherited one (#96)", () => {
    const env = serverEnv({ PATH: "/bin", BUG_SWARM_START_WAVE: "9" }, 4567, "/tmp/d", "playtest-1", QUEEN_WAVE);
    expect(env.BUG_SWARM_START_WAVE).toBe("5");
    expect(serverEnv({ BUG_SWARM_START_WAVE: "9" }, 1, "d", "b", null).BUG_SWARM_START_WAVE).toBeUndefined();
  });
});

describe("chromeCandidates", () => {
  test("--chrome, then CHROME_PATH, then the platform's install places", () => {
    const win = chromeCandidates("win32", { CHROME_PATH: "C:\\c.exe", ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86", LOCALAPPDATA: "C:\\L" }, "D:\\flag.exe");
    expect(win).toEqual([
      "D:\\flag.exe",
      "C:\\c.exe",
      join("C:\\PF", "Google", "Chrome", "Application", "chrome.exe"),
      join("C:\\PF86", "Google", "Chrome", "Application", "chrome.exe"),
      join("C:\\L", "Google", "Chrome", "Application", "chrome.exe"),
    ]);
    expect(chromeCandidates("win32", {})).toEqual([]);
    expect(chromeCandidates("darwin", {})).toEqual([join("/Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]);
    expect(chromeCandidates("linux", { CHROME_PATH: "/opt/c" })).toEqual(["/opt/c", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]);
  });
});

describe("pages and scenarios", () => {
  test("4 pages: desktops and touch phones alternate, so do teams, and every name is a valid, distinct name", () => {
    const pages = pageSpecs(4, "basic", 123456);
    expect(pages.map((p) => p.device.touch)).toEqual([false, true, false, true]);
    expect(pages.map((p) => p.team)).toEqual([TEAMS[0], TEAMS[1], TEAMS[0], TEAMS[1]]);
    expect(new Set(pages.map((p) => p.name)).size).toBe(4);
    for (const p of pageSpecs(20, "basic", 2 ** 31 - 1)) expect(checkName(p.name).ok).toBe(true);
    expect(pages.every((p) => p.role === "fighter")).toBe(true);
    expect(new Set(pages.map((p) => p.seed)).size).toBe(4);
  });

  test("revive: a victim, a reviver and keep-away pages, with enough people that no new fill bot is added", () => {
    expect(pageSpecs(5, "revive", 1).map((p) => p.role)).toEqual(["victim", "reviver", "keepaway", "keepaway", "keepaway"]);
    expect(SCENARIOS.revive.minPlayers).toBe(4);
  });

  test("late-join: every page fights and the last one is the late page; it needs two early pages", () => {
    const pages = pageSpecs(4, "late-join", 1);
    expect(pages.map((p) => p.late)).toEqual([false, false, false, true]);
    expect(pages.every((p) => p.role === "fighter")).toBe(true);
    expect(pageSpecs(4, "basic", 1).some((p) => p.late)).toBe(false);
    expect(SCENARIOS["late-join"].minPlayers).toBe(3);
  });

  test("every scenario runs: none names a follow-up issue (queen was the last, #96)", () => {
    for (const name of SCENARIO_NAMES) expect(SCENARIOS[name].followUp).toBeNull();
  });

  test("queen: every page fights, none joins late", () => {
    const pages = pageSpecs(4, "queen", 1);
    expect(pages.map((p) => p.role)).toEqual(["fighter", "fighter", "fighter", "fighter"]);
    expect(pages.some((p) => p.late)).toBe(false);
  });
});

// ---- A small recorded game: two pages, A (id 1, mouse) and B (id 2, touch). ----

const me = (o: Partial<SnapshotMe> = {}): SnapshotMe => ({ sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 3, al: 1, dk: 0, dc: 0, dn: 0, fx: [], x: 0, y: 0, vx: 0, vy: 0, ...o });
/** A message as the page decodes it. */
const msg = (raw: string) => JSON.parse(raw) as ServerMessage;
const row = (id: number, x: number, vx: number, aim: number, alive: 0 | 1 = 1): SnapshotPlayer => [id, x, 500, vx, 0, aim, alive, 0, 0, 0, 0];
const snapshot = (tick: number, o: { p: SnapshotPlayer[]; k?: SnapshotKill[]; d?: SnapshotDown[]; me: SnapshotMe; ack: number }) =>
  JSON.stringify({ t: "snapshot", tick, ack: o.ack, p: o.p, b: [], s: [], e: [], k: o.k ?? [], d: o.d ?? [], f: [], w: 1, q: [], me: o.me });
const ROSTER = [
  { id: 1, name: "PT-A", team: "tabs" },
  { id: 2, name: "PT-B", team: "spaces" },
];

/** 40 ticks: A kills a bug at tick 10 (10 points); B goes down at 20 and A revives it at 30 (50); A's life ends at 40 with 60. */
function game(): PageLog[] {
  const specs = pageSpecs(2, "basic", 7);
  const logs = specs.map((s, i) => Object.assign(createLog(s), { name: ROSTER[i]!.name }));
  logs.forEach((l, i) => {
    const off = i * 2;
    addFrame(l, 0, 0, msg(JSON.stringify({ t: "welcome", v: 10, you: 0, arena: 9, build: "b", world: { w: 2400, h: 2400 }, tickMs: 50, tick: 0, roster: [] })));
    addFrame(l, 1 + off, 1 + off, msg(JSON.stringify({ t: "welcome", v: 10, you: i + 1, arena: 3, build: "b", world: { w: 2400, h: 2400 }, tickMs: 50, tick: 0, roster: ROSTER })));
    for (let t = 1; t <= 40; t++) {
      const at = t * 50 + off;
      if (t === 20) addFrame(l, at - 1, at - 1, msg(JSON.stringify({ t: "event", kind: "down", id: 2 })));
      if (t === 30) addFrame(l, at - 1, at - 1, msg(JSON.stringify({ t: "event", kind: "revive", id: 2, by: 1, points: 50 })));
      if (t === 40 && i === 0) addFrame(l, at - 1, at - 1, msg(JSON.stringify({ t: "event", kind: "over", id: 1, score: 60, kills: 1, seconds: 2 })));
      const aSc = t >= 30 ? 60 : t >= 10 ? 10 : 0;
      const bDown = t >= 20 && t < 30;
      const mine = i === 0 ? me({ sc: aSc, ki: t >= 10 ? 1 : 0, al: t === 40 ? 0 : 1 }) : me({ dn: bDown ? 1 : 0 });
      // A fill bot (id 3) too: the one row both pages have of someone else.
      const p = [row(1, 100 + t * 15, 300, 0.5, t === 40 ? 0 : 1), row(2, 900 - t * 15, -300, 2), row(3, 500 + t, 0, 1)];
      const k: SnapshotKill[] = t === 10 ? [[77, 1, 300, 500, 10, 0]] : [];
      const d: SnapshotDown[] = bDown ? [[2, 9, 1, 0.1]] : [];
      // What the harness dispatched just before, and what the page sent from it.
      const mx = i === 0 ? 1 : -1;
      const aim = i === 0 ? 0.5 : 2;
      l.intents.push({ hat: at + 1, done: at + 3, mode: "fight", mx, my: 0, aim, fire: true, dash: false });
      addFrame(l, at, at, msg(snapshot(t, { p, k, d, me: mine, ack: t - 1 })));
      addSent(l, at + 10, JSON.stringify({ t: "input", seq: t, mx, my: 0, aim, fire: true, dash: false }));
    }
  });
  logs[0]!.screens.push({ over: 0, text: "60" });
  logs[1]!.tops.push({ at: 40 * 50 + 2500, gen: 0, rows: [{ name: "PT-A", score: 60 }] });
  return logs;
}

describe("recording", () => {
  test("frames before the player welcome (the start screen watching) are skipped; events take their step's tick", () => {
    const [a] = game();
    expect(a!.you).toBe(1);
    expect(a!.welcomes.map((w) => w.arena)).toEqual([3]);
    expect(a!.frames.length).toBe(40);
    expect(a!.events.map((e) => [e.ev.kind, e.tick])).toEqual([
      ["down", 20],
      ["revive", 30],
      ["over", 40],
    ]);
    expect(a!.sent.length).toBe(40);
    const l = createLog(pageSpecs(1 + 1, "basic", 1)[0]!);
    addFrame(l, 0, 0, msg(snapshot(1, { p: [], me: me(), ack: 0 })));
    addSent(l, 0, JSON.stringify({ t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: false, dash: false }));
    expect([l.frames.length, l.sent.length]).toEqual([0, 0]);
  });
});

describe("checks", () => {
  test("each scenario's own check is in its table", () => {
    expect(runChecks(game(), "basic").map((r) => r.name)).not.toContain("revive scenario");
    expect(runChecks(game(), "revive").map((r) => r.name)).toContain("revive scenario");
    const late = runChecks(lateGame(), "late-join").find((r) => r.name === "late-join scenario");
    expect(late?.pass).toBe(true);
    // No restart report: the restart scenario's row is there, and fails.
    const restart = runChecks(restartGame(), "restart", { report: null, budgetMs: 4500 }).find((r) => r.name === "restart scenario");
    expect(restart).toMatchObject({ pass: false, detail: "the server was never restarted" });
  });

  test("a game where the pages agree passes every check", () => {
    const results = runChecks(game(), "basic");
    for (const r of results) expect(`${r.name}: ${r.pass} ${r.detail}`).toBe(`${r.name}: true ${r.detail}`);
    expect(exitCode(results)).toBe(0);
    expect(table(results)).toContain("delivery");
  });

  test("same arena and roster fail when a page is elsewhere or missing someone", () => {
    const logs = game();
    logs[1]!.welcomes[0]!.arena = 4;
    expect(checkSameArena(logs).pass).toBe(false);
    const r = game();
    r[1]!.events.push({ at: 3000, tick: 41, you: 2, gen: 0, ev: { t: "event", kind: "leave", id: 1 } });
    expect(checkRoster(r).pass).toBe(false);
  });

  test("delivery fails on a tick late on every page; one page's gap alone is reported", () => {
    const late = game();
    for (const l of late) for (const f of l.frames.slice(10)) f.at += INTERP_DELAY_MS;
    const r = checkDelivery(late);
    expect(r.detail).toContain("1 ticks late from the server");
    expect(r.pass).toBe(false);
    const onePage = game();
    for (const f of onePage[1]!.frames.slice(10)) f.at += 60;
    const o = checkDelivery(onePage);
    expect(o.detail).toContain("1 over 100 ms on one page only");
    expect(o.pass).toBe(true);
  });

  test("delivery (owner rule, #95): spreads fail only when more than 1% of shared ticks are over 150 ms, or one is over 250 ms; the count over 100 ms is reported", () => {
    // Two pages, `n` shared ticks 50 ms apart; page B receives tick t `lag(t)` ms after page A.
    const pair = (n: number, lag: (t: number) => number): PageLog[] =>
      pageSpecs(2, "basic", 3).map((s, i) => {
        const l = createLog(s);
        addFrame(l, 0, 0, msg(JSON.stringify({ t: "welcome", v: 10, you: i + 1, arena: 1, build: "b", world: { w: 2400, h: 2400 }, tickMs: 50, tick: 0, roster: ROSTER })));
        for (let t = 1; t <= n; t++) addFrame(l, t * 50 + (i === 1 ? lag(t) : 0), 0, msg(snapshot(t, { p: [], me: me(), ack: 0 })));
        return l;
      });
    // The owner's busy-machine run: 3 of 300 ticks at 101 to 111 ms, everything else in step.
    const owner = checkDelivery(pair(300, (t) => (t === 50 ? 101 : t === 150 ? 105 : t === 250 ? 110.7 : 0)));
    expect(owner.pass).toBe(true);
    expect(owner.detail).toContain("3 over 100 ms");
    expect(owner.detail).toContain("0 over 150 ms");
    // 3 of 300 over 150 ms is 1%: passes; 4 of 300 (1.3%) fails.
    expect(checkDelivery(pair(300, (t) => (t % 100 === 0 ? 160 : 0))).pass).toBe(true);
    const four = checkDelivery(pair(300, (t) => (t % 75 === 0 ? 160 : 0)));
    expect(four.pass).toBe(false);
    expect(four.detail).toContain("4 over 150 ms (1.3%");
    // One tick over 250 ms fails on its own.
    expect(checkDelivery(pair(300, (t) => (t === 10 ? 251 : 0))).pass).toBe(false);
  });

  test("positions fail when two pages had a player somewhere else at the same tick; a page's own row is not compared", () => {
    const logs = game();
    expect(checkPositions(logs).detail).toContain("40 player rows");
    const own = game();
    own[0]!.frames[5]!.s.p[0]![1] += 5; // A's own row on A's page
    expect(checkPositions(own).pass).toBe(true);
    const moved = game();
    moved[1]!.frames[5]!.s.p[2]![1] += 0.1; // the bot's row on B's page
    const r = checkPositions(moved);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("tick 6 player 3");
  });

  test("downs and revives fail when a page missed one, or saw another reviver; a run with no down has nothing to compare", () => {
    const missed = game();
    missed[1]!.events = missed[1]!.events.filter((e) => e.ev.kind !== "revive");
    expect(checkEvents(missed, "revive").pass).toBe(false);
    expect(checkEvents(missed, "down").pass).toBe(true);
    const other = game();
    other[1]!.events.find((e) => e.ev.kind === "revive")!.ev.by = 5;
    expect(checkEvents(other, "revive").pass).toBe(false);
    const none = game();
    for (const l of none) l.events = l.events.filter((e) => e.ev.kind !== "down");
    expect(checkEvents(none, "down").pass).toBe(false);
  });

  test("an event's cross-page spread fails only above 250 ms; one over 100 ms is reported", () => {
    const slow = game();
    slow[1]!.events.find((e) => e.ev.kind === "down")!.at += 120;
    const r = checkEvents(slow, "down");
    expect(r.pass).toBe(true);
    expect(r.detail).toContain("1 over 100 ms");
    const lost = game();
    lost[1]!.events.find((e) => e.ev.kind === "down")!.at += 260;
    expect(checkEvents(lost, "down").pass).toBe(false);
  });

  test("kills fail when one page's row for a bug carries other points; a kill only one view had is not compared", () => {
    const logs = game();
    logs[1]!.frames[9]!.s.k = [[77, 1, 300, 500, 20, 0]];
    expect(checkKills(logs).pass).toBe(false);
    const culled = game();
    culled[1]!.frames[9]!.s.k = [];
    culled[0]!.frames[11]!.s.k = [[78, 1, 300, 500, 10, 0]];
    culled[1]!.frames[11]!.s.k = [[78, 1, 300, 500, 10, 0]];
    expect(checkKills(culled).pass).toBe(true);
    expect(checkKills(culled).detail).toContain("2 kills seen, 1 by two or more pages");
  });

  test("score fails when a page's own score is 10 off what another page saw it earn", () => {
    const logs = game();
    for (const f of logs[0]!.frames) if (f.s.tick >= 30 && f.s.me.al === 1) f.s.me.sc += 10;
    const r = checkScore(logs);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("own 70 (1 kills), the pages saw 60 (1 kills)");
  });

  test("score counts a kill any page's view had once, and does not judge a span with a kill no view had", () => {
    const one = game();
    one[0]!.frames[9]!.s.k = []; // only B's view had A's kill
    expect(checkScore(one).pass).toBe(true);
    const none = game();
    for (const l of none) l.frames[9]!.s.k = [];
    const r = checkScore(none);
    expect(r.detail).toContain("1 spans with a kill no page's view had (not judged)");
    // B's span is still judged, so the check has something to say.
    expect(r.pass).toBe(true);
  });

  test("input fails when the page sent something else than was dispatched, or the server's row ignores it", () => {
    const sent = game();
    for (const s of sent[0]!.sent) s.msg.mx = -1;
    expect(checkInput(sent).pass).toBe(false);
    const server = game();
    for (const f of server[1]!.frames) f.s.p[1]![5] = 0;
    expect(checkInput(server).pass).toBe(false);
  });

  test("life over fails when the screen shows another score, or a later top 10 lacks a ranking life", () => {
    const screen = game();
    screen[0]!.screens[0]!.text = "70";
    expect(checkLifeOver(screen).pass).toBe(false);
    const top = game();
    top[1]!.tops[0]!.rows = [{ name: "someone", score: 5 }];
    expect(checkLifeOver(top).pass).toBe(false);
    // Read too soon after the life ended: not judged, so nothing was compared.
    const early = game();
    early[1]!.tops[0]!.at = 40 * 50 + 100;
    expect(checkLifeOver(early).pass).toBe(false);
    // A full top 10 it does not reach: not expected there.
    const low = game();
    low[1]!.tops[0]!.rows = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, score: 1000 - i }));
    low[0]!.tops.push({ at: 40 * 50 + 2600, gen: 0, rows: low[1]!.tops[0]!.rows });
    expect(checkLifeOver(low).pass).toBe(true);
    expect(checkLifeOver(low).detail).toContain("0 later top 10 reads hold every ranking life, 1 pairs of pages' reads agree");
    // Two pages reading at once, no life ending between, see different top 10s.
    const differ = game();
    differ[0]!.tops.push({ at: 40 * 50 + 2600, gen: 0, rows: [{ name: "PT-A", score: 70 }] });
    expect(checkLifeOver(differ).pass).toBe(false);
  });

  test("shownNumber reads the screen's number", () => {
    expect([shownNumber("2,167.5"), shownNumber("60"), shownNumber("..."), shownNumber(null)]).toEqual([2167.5, 60, null, null]);
  });

  test("the revive scenario passes only on a revive of the victim by the reviver, seen by every page", () => {
    const logs = game();
    logs[0]!.role = "reviver";
    logs[1]!.role = "victim";
    expect(checkScenarioRevive(logs).pass).toBe(true);
    logs[0]!.events.find((e) => e.ev.kind === "revive")!.ev.by = 3;
    expect(checkScenarioRevive(logs).pass).toBe(false);
    const byBot = game();
    byBot[0]!.role = "reviver";
    byBot[1]!.role = "victim";
    for (const l of byBot) for (const e of l.events) if (e.ev.kind === "revive") e.ev.by = 9;
    expect(checkScenarioRevive(byBot).detail).toContain("revived by id 9");
  });
});

// ---- The scripted human ----

const ME = { x: 1200, y: 1200 };
function view(o: { bugs?: SnapshotBug[]; players?: SnapshotPlayer[]; downs?: SnapshotDown[]; nums?: Partial<SnapshotMe>; queen?: SnapshotQueen; device?: typeof DESKTOP } = {}): View {
  const mine = row(1, ME.x, 0, 0);
  mine[2] = ME.y;
  return {
    you: 1,
    me: mine,
    nums: me(o.nums),
    players: [mine, ...(o.players ?? [])],
    bugs: o.bugs ?? [],
    downs: o.downs ?? [],
    queen: o.queen ?? [],
    cam: cameraAt(o.device ?? DESKTOP, ME.x, ME.y),
  };
}
const bug = (id: number, dx: number, dy: number): SnapshotBug => [id, 0, ME.x + dx, ME.y + dy];
const at = (id: number, dx: number, dy: number): SnapshotPlayer => [id, ME.x + dx, ME.y + dy, 0, 0, 0, 1, 0, 0, 0, 0];

// ---- Late join: A and B (ids 1, 2) since tick 2900; C (id 4) joins after tick 3000, at wave 6. ----

const welcome = (you: number, tick: number, roster: { id: number; name: string; team: string }[]) =>
  msg(JSON.stringify({ t: "welcome", v: 10, you, arena: 3, build: "b", world: { w: 2400, h: 2400 }, tickMs: 50, tick, roster }));
const LATE_TICK = 3000;
const BOT = { id: 3, name: "Bot", team: "tabs" };
const C = { id: 4, name: "PT-C", team: "tabs" };

/** `firstWave`: the wave C's first snapshot reads; `downTimer`: B's down timer on C's first snapshot; `play`: ticks C plays. */
function lateGame(o: { firstWave?: number; downTimer?: number; play?: number } = {}): PageLog[] {
  const specs = pageSpecs(3, "late-join", 7);
  const logs = specs.map((s, i) => Object.assign(createLog(s), { name: [...ROSTER, C][i]!.name }));
  const end = LATE_TICK + 1 + (o.play ?? Math.ceil(LATE_PLAY_S / 0.05));
  const frame = (l: PageLog, i: number, t: number) => {
    const p = [row(1, 100, 0, 0), row(2, 200, 0, 0), row(3, 300, 0, 0), ...(t > LATE_TICK ? [row(4, 400, 0, 0)] : [])];
    const timer = i === 2 && t === LATE_TICK + 1 && o.downTimer !== undefined ? o.downTimer : 7;
    const w = i === 2 && t === LATE_TICK + 1 && o.firstWave !== undefined ? o.firstWave : t >= LATE_TICK ? 6 : 5;
    const raw = JSON.parse(snapshot(t, { p, d: [[2, timer, 1, 0.1]], me: me(), ack: 0 }));
    addFrame(l, t * 50 + i, t * 50 + i, msg(JSON.stringify({ ...raw, w })));
  };
  for (const i of [0, 1]) {
    const l = logs[i]!;
    addFrame(l, 2900 * 50, 0, welcome(i + 1, 2900, [ROSTER[0]!, ROSTER[1]!, BOT]));
    for (let t = 2901; t <= end; t++) {
      // C's join reaches the early pages with tick LATE_TICK + 1's step.
      if (t === LATE_TICK + 1) addFrame(l, t * 50 - 1, 0, msg(JSON.stringify({ t: "event", kind: "join", id: 4, name: "PT-C", team: "tabs" })));
      frame(l, i, t);
    }
  }
  const c = logs[2]!;
  addFrame(c, LATE_TICK * 50 + 20, 0, welcome(4, LATE_TICK, [ROSTER[0]!, ROSTER[1]!, BOT, C]));
  for (let t = LATE_TICK + 1; t <= end; t++) frame(c, 2, t);
  return logs;
}

describe("late join", () => {
  test("rosterAt: the last welcome by then, then the joins and leaves up to then", () => {
    const [a] = lateGame();
    expect([...rosterAt(a!, LATE_TICK * 50).keys()]).toEqual([1, 2, 3]);
    expect([...rosterAt(a!, (LATE_TICK + 1) * 50).keys()]).toEqual([1, 2, 3, 4]);
    expect(rosterOf(a!)).toEqual(rosterAt(a!, Infinity));
    expect(rosterAt(a!, 0).size).toBe(0);
  });

  test("passes when the late page's first snapshot is at wave 6 and its roster, players and downs match the early pages'", () => {
    const r = checkScenarioLateJoin(lateGame());
    expect(r.detail).toContain(`joined at wave ${LATE_JOIN_WAVE}, first snapshot tick ${LATE_TICK + 1}`);
    expect(r.pass).toBe(true);
  });

  test("fails on a first snapshot before wave 6, a down that differs, a roster missing a page, or too little play after", () => {
    expect(checkScenarioLateJoin(lateGame({ firstWave: 5 })).pass).toBe(false);
    const down = checkScenarioLateJoin(lateGame({ downTimer: 6 }));
    expect(down.pass).toBe(false);
    expect(down.detail).toContain("downs at tick");
    const roster = lateGame();
    roster[2]!.welcomes[0]!.roster = roster[2]!.welcomes[0]!.roster.filter((x) => x.id !== 1);
    const r = checkScenarioLateJoin(roster);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("roster");
    expect(checkScenarioLateJoin(lateGame({ play: 100 })).pass).toBe(false);
  });
});

// ---- Restart: the same game twice, on two server lifetimes that reuse ticks, ids and bug ids. ----

const RESTART_SHIFT = 10_000;

/** On server 1, A aims here (0.5 on server 0). */
const AIM_1 = 1.5;
/** On server 1, B is back only from this tick: after its own down and revive there. */
const B_BACK_1 = 31;

/**
 * game() on server 0, `restarting` on each page, then a second game on server 1 (arena 1) that
 * reuses its ticks, player ids, bug id and input seqs with other content: the fill bot (id 3) 7
 * units over; A aims AIM_1 under the same seqs; A kills bug 77 at tick 12 for 20 points (not at
 * tick 10 for 10), so its score reads 20 then 70; B's frames, events and inputs start only at
 * B_BACK_1, so it was not connected for that lifetime's down and revive; and A reads a top 10 on
 * the new server that differs from B's read on the old one, with no life ending between. A check
 * that compared across lifetimes would fail on each of these.
 */
function restartGame(): PageLog[] {
  const logs = game();
  const next = game();
  logs.forEach((l, i) => {
    const n = next[i]!;
    const back = (tick: number) => i === 0 || tick >= B_BACK_1;
    l.errors.push({ at: 40 * 50 + 100, gen: 0, code: "restarting" });
    l.gen = 1;
    for (const w of n.welcomes) l.welcomes.push({ ...w, at: w.at + RESTART_SHIFT, gen: 1, arena: 1 });
    for (const f of n.frames) {
      const t = f.s.tick;
      if (!back(t)) continue;
      const p = f.s.p.map((r): SnapshotPlayer => {
        const c = [...r] as SnapshotPlayer;
        if (c[0] === 3) c[1] += 7;
        if (c[0] === 1) c[5] = AIM_1;
        return c;
      });
      const k: SnapshotKill[] = t === 12 ? [[77, 1, 300, 500, 20, 0]] : [];
      const me = i === 0 ? { ...f.s.me, sc: t >= 30 ? 70 : t >= 12 ? 20 : 0, ki: t >= 12 ? 1 : 0 } : f.s.me;
      l.frames.push({ ...f, at: f.at + RESTART_SHIFT, hat: f.hat + RESTART_SHIFT, gen: 1, s: { ...f.s, p, k, me } });
    }
    for (const e of n.events) {
      if (!back(e.tick)) continue;
      const ev = e.ev.kind === "over" ? { ...e.ev, score: 70 } : e.ev;
      l.events.push({ ...e, at: e.at + RESTART_SHIFT, gen: 1, ev });
    }
    for (const x of n.sent) if (back(x.msg.seq)) l.sent.push({ ...x, hat: x.hat + RESTART_SHIFT, gen: 1, msg: i === 0 ? { ...x.msg, aim: AIM_1 } : x.msg });
    for (const x of n.intents) if (back(Math.floor(x.hat / 50))) l.intents.push({ ...x, hat: x.hat + RESTART_SHIFT, done: x.done + RESTART_SHIFT, aim: i === 0 ? AIM_1 : x.aim });
  });
  // Read on the new server before its first life ends: it holds the lives the old one saved, and more.
  logs[0]!.tops.push({ at: RESTART_SHIFT + 500, gen: 1, rows: [{ name: "PT-A", score: 60 }, { name: "PT-B", score: 0 }] });
  return logs;
}

const REPORT: RestartReport = { pid0: 11, pid1: 12, code: 0, ms: 600, graceful: true, logLine: "shutdown (ipc): 2 lives saved" };

describe("server lifetimes (restart)", () => {
  test("a welcome takes the log's gen; frames, events, inputs and errors take their connection's", () => {
    const l = createLog(pageSpecs(2, "restart", 1)[0]!);
    addFrame(l, 1, 1, welcome(1, 0, ROSTER));
    addFrame(l, 2, 2, msg(snapshot(1, { p: [], me: me(), ack: 0 })));
    // The harness moves to server 1 before a late frame of server 0's arrives: it keeps gen 0.
    l.gen = 1;
    addFrame(l, 3, 3, msg(snapshot(2, { p: [], me: me(), ack: 0 })));
    addFrame(l, 4, 4, msg(JSON.stringify({ t: "error", code: "restarting" })));
    expect(connGen(l)).toBe(0);
    addFrame(l, 5, 5, welcome(1, 0, ROSTER));
    addFrame(l, 6, 6, msg(snapshot(1, { p: [], me: me(), ack: 0 })));
    addFrame(l, 7, 7, msg(JSON.stringify({ t: "event", kind: "join", id: 9, name: "X", team: "tabs" })));
    addSent(l, 8, JSON.stringify({ t: "input", seq: 1, mx: 0, my: 0, aim: 0, fire: false, dash: false }));
    expect(l.welcomes.map((w) => w.gen)).toEqual([0, 1]);
    expect(l.frames.map((f) => f.gen)).toEqual([0, 0, 1]);
    expect(l.errors).toEqual([{ at: 4, gen: 0, code: "restarting" }]);
    expect([l.events[0]!.gen, l.sent[0]!.gen]).toEqual([1, 1]);
  });

  test("ticks, player ids and bug ids that start again on the new server are compared only within a lifetime", () => {
    const results = runChecks(restartGame(), "restart", { report: null, budgetMs: 4500 });
    for (const r of results.filter((x) => x.name !== "restart scenario")) expect(`${r.name}: ${r.pass} ${r.detail}`).toBe(`${r.name}: true ${r.detail}`);
    const byName = Object.fromEntries(results.map((r) => [r.name, r.detail]));
    expect(byName["same arena"]).toContain("server 0: arena 3; server 1: arena 1");
    expect(byName.positions).toContain("50 player rows");
    expect(byName.delivery).toContain("50 shared ticks");
    expect(byName.delivery).toContain("restart gap");
    expect(byName.delivery).toContain("0 ticks late from the server");
    // B was not on server 1 for its down and revive there: it is not expected to have them.
    expect(byName.downs).toContain("2 downs");
    expect(byName.kills).toContain("2 kills seen");
    expect(byName.score).toContain("4 life spans, 130 points");
    expect(byName.input).toContain("PT-A mouse 100%/100%");
    expect(byName["life over"]).toContain("2 lives over");
  });

  test("a score run ends at the restart even where the new server's ticks carry on from the old one's", () => {
    const logs = restartGame();
    // B's first tick on server 1 is 41, right after its last on server 0; B ends its old life with 50 points and starts at 0.
    const shift = 41 - B_BACK_1;
    for (const l of logs) {
      for (const f of l.frames) if (f.gen === 1) f.s.tick += shift;
      for (const e of l.events) if (e.gen === 1) e.tick += shift;
    }
    expect(logs[1]!.frames.find((f) => f.gen === 1)!.s.tick).toBe(41);
    for (const f of logs[1]!.frames) if (f.gen === 0) f.s.me = { ...f.s.me, sc: 50 };
    const r = checkScore(logs);
    expect(`${r.pass} ${r.detail}`).toBe(`true ${r.detail}`);
  });

  test("roster is checked on each server: a page missing before the restart fails though the last roster is whole", () => {
    expect(checkRoster(restartGame()).detail).toBe("2 pages see all 2 on each of 2 servers");
    // The stopping server's own leaves come after each page's last snapshot from it: not counted.
    const stopped = restartGame();
    for (const l of stopped) l.events.push({ at: 40 * 50 + 50, tick: 41, you: l.you, gen: 0, ev: { t: "event", kind: "leave", id: 3 - l.you } });
    expect(checkRoster(stopped).pass).toBe(true);
    const dropped = restartGame();
    // On server 0, PT-B hears PT-A leave mid-game.
    dropped[1]!.events.push({ at: 30 * 50 + 1, tick: 30, you: 2, gen: 0, ev: { t: "event", kind: "leave", id: 1 } });
    const r = checkRoster(dropped);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("PT-B lacks PT-A on server 0");
  });

  test("same arena fails when the pages land in different arenas on the new server, or one never rejoins", () => {
    const split = restartGame();
    split[1]!.welcomes[1]!.arena = 2;
    expect(checkSameArena(split).pass).toBe(false);
    const gone = restartGame();
    gone[1]!.welcomes.pop();
    expect(checkSameArena(gone).detail).toContain("never joined: PT-B (server 1)");
  });

  test("the restart scenario passes on a graceful stop, restarting on every page, one new welcome on the same build and play after", () => {
    // Long enough on the new server: stretch each page's last gen-1 frame to AFTER_RESTART_S on.
    const long = () => {
      const logs = restartGame();
      for (const l of logs) {
        const f = l.frames[l.frames.length - 1]!;
        l.frames.push({ ...f, at: f.at + AFTER_RESTART_S * 1000, s: { ...f.s, tick: f.s.tick + AFTER_RESTART_S * 20 } });
      }
      return logs;
    };
    const ok = checkScenarioRestart(long(), REPORT, 4500);
    expect(ok.detail).toContain("server 11 stopped gracefully");
    expect(ok.pass).toBe(true);
    expect(checkScenarioRestart(long(), null, 4500).pass).toBe(false);
    expect(checkScenarioRestart(long(), { ...REPORT, graceful: false, code: null }, 4500).pass).toBe(false);
    expect(checkScenarioRestart(long(), { ...REPORT, code: 1 }, 4500).pass).toBe(false);
    expect(checkScenarioRestart(long(), { ...REPORT, ms: 5000 }, 4500).pass).toBe(false);
    const untold = long();
    untold[0]!.errors = [];
    expect(checkScenarioRestart(untold, REPORT, 4500).detail).toContain("never told restarting");
    const never = long();
    never[1]!.welcomes.pop();
    expect(checkScenarioRestart(never, REPORT, 4500).detail).toContain("0 welcomes from the new server");
    const build = long();
    build[0]!.welcomes[1]!.build = "new";
    expect(checkScenarioRestart(build, REPORT, 4500).detail).toContain("rejoined build new");
    // restartGame alone plays 2 s on the new server.
    expect(checkScenarioRestart(restartGame(), REPORT, 4500).detail).toContain("played 2.0 s on the new server");
  });
});

describe("decide", () => {
  test("aims at the nearest bug on screen, not a nearer one off it", () => {
    const cam = cameraAt(DESKTOP, ME.x, ME.y);
    const off = bug(1, 0, cam.h / 2 + 20); // just below the view
    const on = bug(2, cam.h / 2 + 60, 0); // further, but on screen (the view is wider than tall)
    const i = decide(view({ bugs: [off, on] }), createPlan("fighter", 1), 0);
    expect(i.mode).toBe("fight");
    expect(i.aim).toBeCloseTo(0, 6);
  });

  test("fires in bursts: on for 0.6 to 1.2 s, off for 0.3 to 0.6 s", () => {
    const plan = createPlan("fighter", 42);
    const v = view({ bugs: [bug(1, 300, 0)] });
    const runs: { fire: boolean; s: number }[] = [];
    let last: boolean | null = null;
    let since = 0;
    for (let t = 0; t <= 20; t += 0.05) {
      const f = decide(v, plan, t).fire;
      if (f !== last) {
        if (last !== null) runs.push({ fire: last, s: t - since });
        last = f;
        since = t;
      }
    }
    expect(runs.length).toBeGreaterThan(10);
    for (const r of runs.slice(1)) {
      const [lo, hi] = r.fire ? BURST_ON_S : BURST_OFF_S;
      expect(r.s).toBeGreaterThanOrEqual(lo - 0.06);
      expect(r.s).toBeLessThanOrEqual(hi + 0.06);
    }
  });

  test("dashes away from a bug in contact only when the dash is ready; otherwise walks away", () => {
    const close = bug(1, CONTACT_UNITS - 10, 0);
    const ready = decide(view({ bugs: [close] }), createPlan("fighter", 1), 0);
    expect([ready.mode, ready.dash, ready.mx < 0]).toEqual(["evade", true, true]);
    const cooling = decide(view({ bugs: [close], nums: { dc: 10 } }), createPlan("fighter", 1), 0);
    expect([cooling.dash, cooling.mx < 0]).toEqual([false, true]);
    expect(decide(view({ bugs: [bug(1, CONTACT_UNITS + 30, 0)] }), createPlan("fighter", 1), 0).dash).toBe(false);
  });

  test("walks to a downed player and stands inside revive range, still shooting", () => {
    const downs: SnapshotDown[] = [[5, 8, 0, 0]];
    const far = decide(view({ players: [at(5, 300, 0)], downs, bugs: [bug(9, 0, -200)] }), createPlan("fighter", 1), 0);
    expect(far.mode).toBe("revive");
    expect(far.mx).toBeCloseTo(1, 6);
    expect(far.aim).toBeCloseTo(-Math.PI / 2, 6);
    const near = decide(view({ players: [at(5, REVIVE_HOLD_UNITS - 5, 0)], downs }), createPlan("fighter", 1), 0);
    expect([near.mode, near.mx, near.my]).toEqual(["revive", 0, 0]);
    expect(REVIVE_HOLD_UNITS).toBeLessThan(REVIVE_RANGE);
  });

  test("the reviver revives only the victim; keep-away pages and the end phase never revive and back off", () => {
    const downs: SnapshotDown[] = [[5, 8, 0, 0]];
    const reviver = createPlan("reviver", 1);
    reviver.partner = 6;
    expect(decide(view({ players: [at(5, 300, 0)], downs }), reviver, 0).mode).not.toBe("revive");
    reviver.partner = 5;
    expect(decide(view({ players: [at(5, 300, 0)], downs }), reviver, 0).mode).toBe("revive");
    const keep = createPlan("keepaway", 1);
    const k = decide(view({ players: [at(5, 50, 0)], downs }), keep, 0);
    expect(k.mode).not.toBe("revive");
    expect(k.mx).toBeLessThan(0);
    const end = createPlan("fighter", 1);
    end.giveUp = true;
    const e = decide(view({ players: [at(5, 50, 0)], downs, bugs: [bug(1, 400, 0)] }), end, 0);
    expect([e.mode, e.fire, e.mx < 0]).toEqual(["give-up", false, true]);
  });

  test("the victim walks at bugs and never fires or dashes; out or down, nothing is pressed", () => {
    const v = decide(view({ bugs: [bug(1, 0, 40)] }), createPlan("victim", 1), 0);
    expect([v.mode, v.fire, v.dash, v.my]).toEqual(["victim", false, false, 1]);
    expect(decide(view({ nums: { al: 0 } }), createPlan("fighter", 1), 0)).toEqual({ mode: "out", mx: 0, my: 0, aim: null, fire: false, dash: false });
    expect(decide(view({ nums: { dn: 1 } }), createPlan("fighter", 1), 0).mode).toBe("down");
  });

  test("with nothing on screen it wanders inside the arena, without firing", () => {
    const plan = createPlan("fighter", 3);
    const i = decide(view(), plan, 0);
    expect([i.mode, i.fire, i.aim]).toEqual(["roam", false, null]);
    expect(Math.hypot(i.mx, i.my)).toBeCloseTo(1, 6);
    expect(plan.wander.x).toBeGreaterThan(0);
    expect(plan.wander.x).toBeLessThan(WORLD_W);
    expect(plan.wander.y).toBeLessThan(WORLD_H);
  });

  // The hive queen at (dx, dy) from the page, alive with 100 of 150 hit points.
  const queenAt = (dx: number, dy: number): SnapshotQueen => [1, 50, ME.x + dx, ME.y + dy, 100, 150];
  const queenPlan = (on = true) => Object.assign(createPlan("fighter", 1), { queenFirst: on });

  test("queen focus: she is the target when on screen, over a nearer bug; without it, the nearest bug is", () => {
    const v = view({ bugs: [bug(1, 0, 150)], queen: queenAt(300, 0) });
    const i = decide(v, queenPlan(), 0);
    expect(i.mode).toBe("queen");
    expect(i.aim).toBeCloseTo(0, 6);
    expect(i.fire).toBe(true);
    const plain = decide(v, queenPlan(false), 0);
    expect(plain.mode).toBe("fight");
    expect(plain.aim).toBeCloseTo(Math.PI / 2, 6);
  });

  test("queen focus: off screen it walks to her, shooting what is on screen; on a phone it stands off where she stays on screen", () => {
    const i = decide(view({ bugs: [bug(1, 0, -150)], queen: queenAt(-1000, 0) }), queenPlan(), 0);
    expect(i.mode).toBe("queen-seek");
    expect(i.mx).toBeCloseTo(-1, 6);
    expect(i.aim).toBeCloseTo(-Math.PI / 2, 6);
    // A phone's view is about 370 units wide: 160 to her side she is on it, and the page strafes rather than backing off her screen.
    const p = decide(view({ queen: queenAt(160, 0), device: PHONE }), queenPlan(), 0);
    expect(p.mode).toBe("queen");
    expect(p.mx).toBeCloseTo(0, 6);
    expect(Math.abs(p.my)).toBeCloseTo(1, 6);
    // Too close: it backs off.
    const close = decide(view({ queen: queenAt(QUEEN_NEAR_UNITS - 20, 0) }), queenPlan(), 0);
    expect(close.mx).toBeCloseTo(-1, 6);
  });

  test("queen focus: in contact with a bug it still dashes, aiming at her; her marker alone changes nothing", () => {
    const e = decide(view({ bugs: [bug(1, 0, CONTACT_UNITS - 10)], queen: queenAt(300, 0) }), queenPlan(), 0);
    expect([e.mode, e.dash]).toEqual(["evade", true]);
    expect(e.aim).toBeCloseTo(0, 6);
    const marker: SnapshotQueen = [0, ME.x + 300, ME.y, 30];
    const m = decide(view({ bugs: [bug(1, 0, 150)], queen: marker }), queenPlan(), 0);
    expect(m.mode).toBe("fight");
    expect(m.aim).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe("intent to input", () => {
  test("WASD for a move, diagonals hold two keys, and the move they give", () => {
    expect(moveKeys(1, 0)).toEqual(["KeyD"]);
    expect(moveKeys(-Math.SQRT1_2, -Math.SQRT1_2)).toEqual(["KeyW", "KeyA"]);
    expect(moveKeys(0, 0)).toEqual([]);
    expect(moveKeys(0.95, 0.3)).toEqual(["KeyD"]);
    expect(keysMove(["KeyS", "KeyD"]).x).toBeCloseTo(Math.SQRT1_2, 6);
    expect(keysMove([])).toEqual({ x: 0, y: 0 });
  });

  test("the mouse sits MOUSE_REACH px from the robot along the aim; a moving robot is drawn ahead of the trailing camera", () => {
    const still = mouseAt(DESKTOP, 1200, 1200, 0, 0, 0);
    expect(still).toEqual({ x: DESKTOP.width / 2 + MOUSE_REACH, y: DESKTOP.height / 2 });
    const moving = mouseAt(DESKTOP, 1200, 1200, 300, 0, Math.PI / 2);
    expect(moving.x).toBeGreaterThan(DESKTOP.width / 2);
    expect(moving.y).toBeCloseTo(DESKTOP.height / 2 + MOUSE_REACH, 6);
    // Near a wall the camera stops, so the robot is off centre.
    expect(mouseAt(DESKTOP, 20, 1200, 0, 0, 0).x).toBeLessThan(DESKTOP.width / 2);
  });

  test("thumbs land on the left and right halves, clear of the dash button; the move thumb drags a full stick, the aim thumb past the dead zone only while firing", () => {
    const l = touchLayout(PHONE);
    expect(l.left.x).toBeLessThan(PHONE.width / 2);
    expect(l.right.x).toBeGreaterThan(PHONE.width / 2);
    const b = dashButtonAt(PHONE.width, PHONE.height, { top: 0, right: 0, bottom: 0, left: 0 }, { x: 0, y: 0, r: 0, id: -1 });
    expect(l.dash).toEqual({ x: b.x, y: b.y });
    expect(Math.hypot(l.right.x - b.x, l.right.y - b.y)).toBeGreaterThan(DASH_BUTTON_RADIUS + 6 + STICK_DEAD * 6);
    const [move, aim] = touchPoints(l, { mode: "fight", mx: 0, my: -1, aim: Math.PI, fire: true, dash: false });
    expect(move).toEqual({ id: MOVE_FINGER, x: l.left.x, y: l.left.y - STICK_RANGE });
    expect(aim.id).toBe(AIM_FINGER);
    expect(Math.hypot(aim.x - l.right.x, aim.y - l.right.y)).toBeGreaterThan(STICK_DEAD);
    expect(aim.x).toBeLessThan(l.right.x);
    const [, rest] = touchPoints(l, { mode: "fight", mx: 0, my: 0, aim: Math.PI, fire: false, dash: false });
    expect(rest).toEqual({ id: AIM_FINGER, x: l.right.x, y: l.right.y });
  });
});

// ---- The queen scenario (#96): A (id 1) and B (id 2) share her marker (ticks 6 to 10), her alive (11 to 19) and her kill at tick 20. ----

const KILL_TICK = 20;
const PAID: [number, number][] = [
  [1, 575],
  [2, 100],
];

/**
 * `bHp`: a tick at which B reads her hit points one higher; `bMissing`: B has no queen event;
 * `paid`: every page's copy of `paid`, `bPaid` B's only; `aShort`: A's score at the kill is this
 * short; `marker`: false for no marker; `top`: the top dealer's id.
 */
function queenGame(o: { bHp?: number; bMissing?: boolean; paid?: [number, number][]; bPaid?: [number, number][]; aShort?: number; marker?: boolean; top?: number } = {}): PageLog[] {
  const specs = pageSpecs(2, "queen", 7);
  const logs = specs.map((s, i) => Object.assign(createLog(s), { name: ROSTER[i]!.name }));
  logs.forEach((l, i) => {
    const id = i + 1;
    const off = i * 2;
    addFrame(l, 1 + off, 1 + off, welcome(id, 0, ROSTER));
    for (let t = 1; t <= 25; t++) {
      const at = t * 50 + off;
      let q: SnapshotQueen = [];
      if (t >= 6 && t <= 10 && o.marker !== false) q = [0, 1200, 1200, 11 - t];
      else if (t >= 11 && t < KILL_TICK) q = [1, 50, 1200, 1200, 100 - (t - 11) * 10 + (i === 1 && t === o.bHp ? 1 : 0), 150];
      if (t === KILL_TICK && !(i === 1 && o.bMissing)) {
        const paid = i === 1 && o.bPaid ? o.bPaid : (o.paid ?? PAID);
        addFrame(l, at - 1, at - 1, msg(JSON.stringify({ t: "event", kind: "queen", id: o.top ?? 1, paid })));
      }
      const pay = PAID.find((p) => p[0] === id)![1] - (i === 0 ? (o.aShort ?? 0) : 0);
      const mine = me({ sc: t >= KILL_TICK ? pay : 0 });
      const p = [row(1, 100, 0, 0), row(2, 900, 0, 0)];
      addFrame(l, at, at, msg(JSON.stringify({ t: "snapshot", tick: t, ack: t, p, b: [], s: [], e: [], k: [], d: [], f: [], w: 5, q, me: mine })));
    }
  });
  return logs;
}

describe("the queen scenario", () => {
  test("pages that agree on her q, her event and their pay pass all three; the queen table has them", () => {
    const logs = queenGame();
    expect(logs[0]!.frames[5]!.s.q).toEqual([0, 1200, 1200, 5]);
    for (const r of [checkQueenSnapshots(logs), checkQueenEvent(logs), checkQueenPay(logs)]) expect(`${r.name}: ${r.pass} ${r.detail}`).toBe(`${r.name}: true ${r.detail}`);
    expect(checkQueenSnapshots(logs).detail).toBe("25 shared ticks agree: 5 marker, 9 alive (hp from 100 to 20 of 150), 11 none");
    expect(checkQueenEvent(logs).detail).toContain("PT-A dealt the most; 2 paid (PT-A, PT-B)");
    expect(checkQueenPay(logs).detail).toContain("PT-A +575, PT-B +100");
    expect(runChecks(logs, "queen").map((r) => r.name)).toEqual(expect.arrayContaining(["queen q", "queen event", "queen pay"]));
    expect(runChecks(game(), "basic").map((r) => r.name)).not.toContain("queen q");
  });

  test("queen q fails on one tick where B reads other hit points, or with no shared tick of her marker", () => {
    const hp = checkQueenSnapshots(queenGame({ bHp: 14 }));
    expect(hp.pass).toBe(false);
    expect(hp.detail).toContain("tick 14: PT-A [1,50,1200,1200,70,150], PT-B [1,50,1200,1200,71,150]");
    const late = checkQueenSnapshots(queenGame({ marker: false }));
    expect(late.pass).toBe(false);
    expect(late.detail).toContain("no two pages shared a tick of her marker");
  });

  test("queen event fails when a connected page missed it, its copies differ, no page was paid, or she was never killed", () => {
    expect(checkQueenEvent(queenGame({ bMissing: true }))).toMatchObject({ pass: false, detail: "PT-B missed the queen event at tick 20" });
    const differs = checkQueenEvent(queenGame({ bPaid: [[1, 575]] }));
    expect([differs.pass, differs.detail]).toEqual([false, "the queen event at tick 20 differs: [1,[[1,575],[2,100]]] vs [1,[[1,575]]]"]);
    expect(checkQueenEvent(queenGame({ paid: [[3, 675]], top: 3 }))).toMatchObject({ pass: false, detail: "no page was paid: none of them damaged her" });
    expect(checkQueenEvent(queenGame({ top: 9 })).detail).toContain("a fill bot dealt the most");
    expect(checkQueenEvent(queenGame().map((l) => ({ ...l, events: [] }))).pass).toBe(false);
  });

  test("queen pay fails when a page's own score at the kill lacks its paid points", () => {
    expect(checkQueenPay(queenGame({ aShort: 75 }))).toMatchObject({ pass: false, detail: "PT-A at tick 20: own score +500, expected +575 (paid 575, kills 0, revives 0)" });
    expect(checkQueenPay(queenGame().map((l) => ({ ...l, events: [] }))).pass).toBe(false);
  });
});
