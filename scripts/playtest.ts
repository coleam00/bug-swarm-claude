// `bun run playtest -- --url <base> [--players 4] [--seconds 90] [--scenario basic|revive]` (#94):
// several real browser players in one arena at once, each a headless Chrome page (desktops with a
// mouse and keyboard and phones with two-point touch, mixed) that joins through the start screen
// with its own name and team and plays a scripted human (playtest-lib.ts decide) with real
// Input.* events only. Each page's received frames, /api/top reads and life-over screen are
// recorded; at the end the checks print a pass/fail table (exit 1 on a fail). Screenshots every
// 15 s and the pages' logs go to .evidence/playtest/. It plays lives that save, so point it at a
// server with a scratch DATA_DIR. Not part of `bun run check`: it needs Chrome and a server.
// Raw Chrome DevTools Protocol over Bun's WebSocket: no browser library.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOWN_S } from "../src/shared/arena/constants";
import { DOWN, OVER, REVIVE, SNAPSHOT, parseServerMessage, type Snapshot } from "../src/shared/arena/protocol";
import { createSnapshotReader } from "../src/shared/arena/view";
import { RESTART_DELAY_MS } from "../src/web/game/guard";
import {
  AIM_FINGER,
  DASH_FINGER,
  MOVE_FINGER,
  SCENARIOS,
  USAGE,
  addFrame,
  addSent,
  cameraAt,
  chromeCandidates,
  createLog,
  createPlan,
  decide,
  exitCode,
  keysMove,
  mouseAt,
  moveKeys,
  pageSpecs,
  parseArgs,
  runChecks,
  table,
  touchLayout,
  touchPoints,
  type Intent,
  type PageLog,
  type PageSpec,
  type Plan,
  type TouchPoint,
} from "./playtest-lib";

/** The control loop's step, ms: one decision and its input per page. */
const STEP_MS = 50;
/** A screenshot per page this often, ms. */
const SHOT_MS = 15_000;
/** Pages join this far apart, ms. */
const JOIN_GAP_MS = 300;
/** The life-over screen is read and "Play again" pressed this long after the over event, ms. */
const AGAIN_MS = RESTART_DELAY_MS + 400;
/** The end phase waits at most this for every life to end, ms. */
const END_CAP_MS = (90 + DOWN_S) * 1000;
/** After the last life ends, the life-over screens keep reading the top 10 this long, ms (they poll every 4 s). */
const TOP_TAIL_MS = 6000;
/** In the revive scenario, the victim must go down within this, s. */
const VICTIM_DOWN_S = 120;
/** The revive scenario plays on past --seconds until the revive, at most this, s. */
const REVIVE_WAIT_S = 180;

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(`${(e as Error).message}\n${USAGE}`);
  process.exit(2);
}
const scenario = SCENARIOS[args.scenario];
if (scenario.followUp !== null) {
  console.error(`scenario "${scenario.name}" is not built yet (${scenario.why}): see https://github.com/coleam00/bug-swarm-claude/issues/${scenario.followUp}`);
  process.exit(2);
}
if (args.players < scenario.minPlayers) {
  console.error(`scenario "${scenario.name}" needs --players ${scenario.minPlayers} or more`);
  process.exit(2);
}

const root = join(import.meta.dir, "..");
const outDir = join(root, ".evidence", "playtest");
mkdirSync(outDir, { recursive: true });
const t0 = performance.now();
const now = () => performance.now();
const secs = () => (now() - t0) / 1000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(`${secs().toFixed(1).padStart(6)}s ${s}`);

// ---- Chrome ----

function findChrome(): string {
  const tried = chromeCandidates(process.platform, process.env, args.chrome);
  for (const c of tried) {
    if (existsSync(c)) return c;
    const onPath = Bun.which(c);
    if (onPath) return onPath;
  }
  console.error(`Chrome not found. Tried:\n  ${tried.join("\n  ")}\nPass --chrome <path> or set CHROME_PATH.`);
  process.exit(2);
}

const chromePath = findChrome();
const profile = join(outDir, `chrome-profile-${process.pid}`);
rmSync(profile, { recursive: true, force: true });
const chrome = Bun.spawn(
  [
    chromePath,
    ...(args.headed ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

type Handler = (method: string, params: any) => void;
type Cdp = { send: (method: string, params?: object, session?: string) => Promise<any>; on: (session: string, h: Handler) => void; close: () => void };

/** One DevTools connection to the browser; pages are flattened sessions on it. A command that fails rejects. */
async function connect(url: string): Promise<Cdp> {
  const ws = new WebSocket(url);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`could not connect to Chrome at ${url}`));
  });
  let next = 1;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; method: string }>();
  const handlers = new Map<string, Handler>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (!p) return;
      if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`));
      else p.res(m.result);
    } else if (m.sessionId) handlers.get(m.sessionId)?.(m.method, m.params);
  };
  ws.onclose = () => {
    for (const p of pending.values()) p.rej(new Error(`${p.method}: Chrome went away`));
    pending.clear();
  };
  return {
    send: (method, params = {}, session) =>
      new Promise((res, rej) => {
        const id = next++;
        pending.set(id, { res, rej, method });
        ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
      }),
    on: (session, h) => handlers.set(session, h),
    close: () => ws.close(),
  };
}

async function devtoolsUrl(): Promise<string> {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 120; i++) {
    if (existsSync(file)) {
      const port = readFileSync(file, "utf8").split("\n")[0]!.trim();
      if (port) {
        const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string; Browser: string };
        say(`${v.Browser}, pid ${chrome.pid}`);
        return v.webSocketDebuggerUrl;
      }
    }
    await wait(250);
  }
  throw new Error("Chrome did not open its DevTools port");
}

// ---- Pages ----

type Page = {
  spec: PageSpec;
  log: PageLog;
  plan: Plan;
  session: string;
  latest: Snapshot | null;
  busy: boolean;
  keys: string[];
  mouseDown: boolean;
  fingers: boolean;
  /** The last mouse point or thumbs sent, so an unchanged one is not sent again. */
  lastMove: string;
  dashFinger: TouchPoint | null;
  /** The harness time of the over event not yet handled, and how many overs so far. */
  overAt: number | null;
  overs: number;
  /** When "Play again" was last pressed (harness ms). */
  againAt: number;
  tops: Map<string, number>;
  maxBots: number;
  /** A snapshot reader per WebSocket the page opened (by DevTools request id). */
  readers: Map<string, ReturnType<typeof createSnapshotReader>>;
};

let cdp: Cdp | null = null;
const pages: Page[] = [];
let endPhase = false;
let stopping = false;

const key = (code: string) => {
  if (code === "Space") return { code, key: " ", windowsVirtualKeyCode: 32 };
  const ch = code.slice(3).toLowerCase();
  return { code, key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) };
};

async function evaluate(pg: Page, expression: string): Promise<any> {
  const r = await cdp!.send("Runtime.evaluate", { expression, returnByValue: true }, pg.session);
  return r?.result?.value;
}

/** The centre of an element on screen (layout only, never game state), or null. */
async function centreOf(pg: Page, selector: string, index = 0): Promise<{ x: number; y: number } | null> {
  return evaluate(
    pg,
    `(() => { const e = document.querySelectorAll(${JSON.stringify(selector)})[${index}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
  );
}

/** A click (mouse) or a tap (touch) at a screen point. */
async function press(pg: Page, p: { x: number; y: number }): Promise<void> {
  const s = pg.session;
  if (pg.spec.device.touch) {
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 9, x: p.x, y: p.y }] }, s);
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
  } else {
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, buttons: 0 }, s);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 }, s);
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 }, s);
  }
}

async function until<T>(what: string, ms: number, f: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(150);
  }
}

async function openPage(spec: PageSpec): Promise<Page> {
  const { browserContextId } = await cdp!.send("Target.createBrowserContext", {});
  const { targetId } = await cdp!.send("Target.createTarget", { url: "about:blank", browserContextId });
  const { sessionId } = await cdp!.send("Target.attachToTarget", { targetId, flatten: true });
  const pg: Page = {
    spec,
    log: createLog(spec),
    plan: createPlan(spec.role, spec.seed),
    session: sessionId,
    latest: null,
    busy: false,
    keys: [],
    mouseDown: false,
    fingers: false,
    lastMove: "",
    dashFinger: null,
    overAt: null,
    overs: 0,
    againAt: 0,
    tops: new Map(),
    maxBots: 0,
    readers: new Map(),
  };
  cdp!.on(sessionId, (method, p) => {
    if (method === "Network.webSocketFrameReceived") {
      // Decoded as the page decodes it: one snapshot reader (view.ts) per socket.
      let read = pg.readers.get(p.requestId);
      if (!read) pg.readers.set(p.requestId, (read = createSnapshotReader()));
      const wire = parseServerMessage(String(p.response?.payloadData ?? ""));
      const m = wire ? read(wire) : null;
      addFrame(pg.log, p.timestamp * 1000, now(), m);
      if (!m || pg.log.you === 0) return;
      if (m.t === SNAPSHOT) {
        pg.latest = m;
        // Fill bots: rows that are none of the pages, once every page has joined.
        if (pages.length < args.players || pages.some((o) => o.log.you === 0)) return;
        const people = new Set(pages.map((o) => o.log.you));
        let bots = 0;
        for (const r of m.p) if (!people.has(r[0])) bots++;
        pg.maxBots = Math.max(pg.maxBots, bots);
      } else if (m.t === "event") {
        if (m.kind === OVER && m.id === pg.log.you) {
          pg.overAt = now();
          pg.overs++;
          say(`${spec.name} life over: ${m.score} points, ${m.kills} kills`);
        } else if (m.kind === DOWN && m.id === pg.log.you) say(`${spec.name} is down`);
        else if (m.kind === REVIVE && m.id === pg.log.you) say(`${spec.name} revived by id ${m.by}`);
      }
    } else if (method === "Network.webSocketFrameSent") addSent(pg.log, now(), String(p.response?.payloadData ?? ""));
    else if (method === "Network.responseReceived" && /\/api\/top(\?|$)/.test(new URL(p.response.url).pathname + new URL(p.response.url).search)) {
      pg.tops.set(p.requestId, p.timestamp * 1000);
    } else if (method === "Network.loadingFinished" && pg.tops.has(p.requestId)) {
      const at = pg.tops.get(p.requestId)!;
      pg.tops.delete(p.requestId);
      cdp!
        .send("Network.getResponseBody", { requestId: p.requestId }, sessionId)
        .then((r) => {
          const body = JSON.parse(r.body) as { top?: { name: string; score: number }[] };
          if (Array.isArray(body.top)) pg.log.tops.push({ at, rows: body.top.map((x) => ({ name: x.name, score: x.score })) });
        })
        .catch((e) => !stopping && say(`${spec.name} top 10 body: ${(e as Error).message}`));
    } else if (method === "Runtime.exceptionThrown") say(`${spec.name} page error: ${JSON.stringify(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text).slice(0, 300)}`);
  });
  const s = sessionId;
  await cdp!.send("Network.enable", {}, s);
  await cdp!.send("Page.enable", {}, s);
  await cdp!.send("Runtime.enable", {}, s);
  await cdp!.send("Emulation.setFocusEmulationEnabled", { enabled: true }, s);
  const d = spec.device;
  await cdp!.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.scale, mobile: d.touch }, s);
  if (d.touch) await cdp!.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 }, s);
  await cdp!.send("Page.navigate", { url: `${args.url}/` }, s);
  // The start screen, as a person uses it: tap the name field, type, tap the team.
  const field = await until(`${spec.name}'s name field`, 15_000, () => centreOf(pg, "input[aria-label='Your name']"));
  await press(pg, field);
  await cdp!.send("Input.insertText", { text: spec.name }, s);
  const teams: string[] = await evaluate(pg, `[...document.querySelectorAll(".start-teams button")].map((b) => b.textContent ?? "")`);
  const i = teams.findIndex((t) => t.toLowerCase().includes(spec.team));
  if (i < 0) throw new Error(`${spec.name}: no button for team ${spec.team} (${teams.join(", ")})`);
  await press(pg, (await centreOf(pg, ".start-teams button", i))!);
  await until(`${spec.name}'s welcome`, 15_000, async () => pg.log.you !== 0);
  say(`${spec.name} joined as id ${pg.log.you} (${spec.team}, ${d.touch ? `touch ${d.width}x${d.height}` : `mouse ${d.width}x${d.height}`}, ${spec.role}) in arena ${pg.log.welcomes[0]!.arena}`);
  return pg;
}

// ---- Input ----

async function releaseAll(pg: Page): Promise<void> {
  const s = pg.session;
  for (const k of pg.keys) await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", ...key(k) }, s);
  pg.keys = [];
  if (pg.mouseDown) {
    await cdp!.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 2, y: 2, button: "left", buttons: 0, clickCount: 1 }, s);
    pg.mouseDown = false;
  }
  if (pg.fingers || pg.dashFinger) {
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }, s);
    pg.fingers = false;
    pg.dashFinger = null;
  }
}

/** Sends the intent as the page's real input: keys and mouse on a desktop, two thumbs (and a dash tap) on a phone. */
async function dispatch(pg: Page, intent: Intent, me: { x: number; y: number; vx: number; vy: number }): Promise<void> {
  const s = pg.session;
  const d = pg.spec.device;
  const hat = now();
  const up = intent.mode !== "out" && intent.mode !== "down";
  if (!up) {
    await releaseAll(pg);
    pg.log.intents.push({ hat, done: now(), mode: intent.mode, mx: 0, my: 0, aim: null, fire: false, dash: false });
    return;
  }
  const fire = intent.fire && intent.aim !== null;
  if (!d.touch) {
    const keys = moveKeys(intent.mx, intent.my);
    for (const k of pg.keys) if (!keys.includes(k)) await cdp!.send("Input.dispatchKeyEvent", { type: "keyUp", ...key(k) }, s);
    for (const k of keys) if (!pg.keys.includes(k)) await cdp!.send("Input.dispatchKeyEvent", { type: "keyDown", ...key(k) }, s);
    pg.keys = keys;
    const at = intent.aim !== null ? mouseAt(d, me.x, me.y, me.vx, me.vy, intent.aim) : null;
    const moved = at ? `${Math.round(at.x)},${Math.round(at.y)}` : pg.lastMove;
    if (at && moved !== pg.lastMove) await cdp!.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, buttons: pg.mouseDown ? 1 : 0 }, s);
    pg.lastMove = moved;
    if (fire !== pg.mouseDown && at) {
      await cdp!.send("Input.dispatchMouseEvent", { type: fire ? "mousePressed" : "mouseReleased", x: at.x, y: at.y, button: "left", buttons: fire ? 1 : 0, clickCount: 1 }, s);
      pg.mouseDown = fire;
    }
    if (intent.dash) for (const type of ["keyDown", "keyUp"]) await cdp!.send("Input.dispatchKeyEvent", { type, ...key("Space") }, s);
    const m = keysMove(keys);
    pg.log.intents.push({ hat, done: now(), mode: intent.mode, mx: m.x, my: m.y, aim: intent.aim, fire: pg.mouseDown, dash: intent.dash });
    return;
  }
  const layout = touchLayout(d);
  const pts = touchPoints(layout, intent);
  if (pg.dashFinger) {
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [pg.dashFinger] }, s);
    pg.dashFinger = null;
  }
  if (!pg.fingers) {
    // Thumbs land on the sticks' centres (a floating stick centres where the finger lands), then drag.
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: MOVE_FINGER, ...layout.left }, { id: AIM_FINGER, ...layout.right }] }, s);
    pg.fingers = true;
    pg.lastMove = "";
  }
  const moved = pts.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ");
  if (moved !== pg.lastMove) await cdp!.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts }, s);
  pg.lastMove = moved;
  if (intent.dash) {
    pg.dashFinger = { id: DASH_FINGER, ...layout.dash };
    await cdp!.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [...pts, pg.dashFinger] }, s);
  }
  const len = Math.hypot(intent.mx, intent.my);
  pg.log.intents.push({ hat, done: now(), mode: intent.mode, mx: len ? intent.mx / len : 0, my: len ? intent.my / len : 0, aim: intent.aim, fire, dash: intent.dash });
}

/** One control step for a page: the life-over screen, or a decision and its input. */
async function step(pg: Page): Promise<void> {
  const snap = pg.latest;
  if (!snap) return;
  if (pg.overAt !== null) {
    if (now() - pg.overAt < AGAIN_MS) return releaseAll(pg);
    const text: string | null = await evaluate(pg, `document.querySelector(".over-score")?.textContent ?? null`);
    pg.log.screens.push({ over: pg.overs - 1, text });
    pg.overAt = null;
    if (!endPhase) {
      await press(pg, { x: pg.spec.device.width / 2, y: pg.spec.device.height / 2 });
      pg.againAt = now();
    }
    return;
  }
  // Out with no pending over (the tap did not take): press "Play again" again.
  if (snap.me.al === 0 && !endPhase && pg.overs > 0 && now() - pg.againAt > 3000) {
    await press(pg, { x: pg.spec.device.width / 2, y: pg.spec.device.height / 2 });
    pg.againAt = now();
    return;
  }
  const me = snap.p.find((r) => r[0] === pg.log.you) ?? null;
  const cam = me ? cameraAt(pg.spec.device, me[1], me[2]) : { x: 0, y: 0, w: 0, h: 0 };
  const intent = decide({ you: pg.log.you, me, nums: snap.me, players: snap.p, bugs: snap.b, downs: snap.d, cam }, pg.plan, secs());
  await dispatch(pg, intent, me ? { x: me[1], y: me[2], vx: me[3], vy: me[4] } : { x: 0, y: 0, vx: 0, vy: 0 });
}

async function screenshots(label: string): Promise<void> {
  await Promise.all(
    pages.map(async (pg) => {
      try {
        const r = await cdp!.send("Page.captureScreenshot", { format: "png" }, pg.session);
        writeFileSync(join(outDir, `${args.scenario}-${pg.spec.name}-${label}.png`), Buffer.from(r.data, "base64"));
      } catch (e) {
        say(`${pg.spec.name} screenshot: ${(e as Error).message}`);
      }
    }),
  );
}

// ---- The run ----

async function shutdown(): Promise<void> {
  try {
    await cdp?.send("Browser.close");
  } catch {
    // Already gone.
  }
  cdp?.close();
  const exited = await Promise.race([chrome.exited.then(() => true), wait(10_000).then(() => false)]);
  if (!exited) {
    chrome.kill();
    await chrome.exited;
  }
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(profile, { recursive: true, force: true });
      break;
    } catch {
      await wait(250);
    }
  }
}

process.on("SIGINT", () => {
  if (stopping) return;
  stopping = true;
  say("interrupted: closing Chrome");
  void shutdown().then(() => process.exit(130));
});

let code = 1;
try {
  cdp = await connect(await devtoolsUrl());
  const seed = Math.floor(Math.random() * 2 ** 31);
  const specs = pageSpecs(args.players, args.scenario, seed);
  say(`scenario ${args.scenario}: ${args.players} pages against ${args.url} for ${args.seconds} s`);
  for (const spec of specs) {
    pages.push(await openPage(spec));
    await wait(JOIN_GAP_MS);
  }
  const arenas = new Set(pages.map((p) => p.log.welcomes[0]!.arena));
  if (arenas.size > 1) throw new Error(`pages landed in different arenas: ${[...arenas].join(", ")}`);
  const victim = pages.find((p) => p.spec.role === "victim");
  if (victim) for (const p of pages) if (p.spec.role === "reviver" || p.spec.role === "keepaway") p.plan.partner = victim.log.you;

  const start = secs();
  let nextShot = 0;
  let victimDown = false;
  let revived = false;
  const loop = setInterval(() => {
    for (const pg of pages) {
      if (pg.busy || stopping) continue;
      pg.busy = true;
      step(pg)
        .catch((e) => say(`${pg.spec.name} step: ${(e as Error).message}`))
        .finally(() => (pg.busy = false));
    }
  }, STEP_MS);
  // Play.
  for (;;) {
    const t = secs() - start;
    if (t * 1000 >= nextShot) {
      void screenshots(`${Math.round(nextShot / 1000)}s`);
      nextShot += SHOT_MS;
    }
    if (victim) {
      victimDown ||= victim.log.events.some((e) => e.ev.kind === DOWN && e.ev.id === victim.log.you);
      const reviver = pages.find((p) => p.spec.role === "reviver")!;
      if (!revived && victim.log.events.some((e) => e.ev.kind === REVIVE && e.ev.id === victim.log.you && e.ev.by === reviver.log.you)) {
        revived = true;
        // Revived once: from here the victim plays on as a keep-away page.
        victim.plan.role = "keepaway";
      }
      if (!victimDown && t > VICTIM_DOWN_S) {
        say(`victim not down after ${VICTIM_DOWN_S} s`);
        break;
      }
    }
    if (stopping) break;
    if (t >= args.seconds && (!victim || revived || t >= REVIVE_WAIT_S)) break;
    await wait(200);
  }
  // End: everyone stops fighting until every life is over.
  endPhase = true;
  for (const p of pages) p.plan.giveUp = true;
  const endAt = now();
  say("end phase: every page stops firing and walks at the bugs");
  while (!stopping && now() - endAt < END_CAP_MS) {
    if (pages.every((p) => p.latest?.me.al === 0 && p.overAt === null)) break;
    const t = secs() - start;
    if (t * 1000 >= nextShot) {
      void screenshots(`${Math.round(nextShot / 1000)}s`);
      nextShot += SHOT_MS;
    }
    await wait(200);
  }
  const alive = pages.filter((p) => p.latest?.me.al !== 0).map((p) => p.spec.name);
  if (alive.length > 0) say(`still in a life after the end phase: ${alive.join(", ")}`);
  await wait(TOP_TAIL_MS);
  clearInterval(loop);
  await screenshots("end");
  // Results.
  for (const pg of pages) {
    const l = pg.log;
    const file = join(outDir, `${args.scenario}-${pg.spec.name}.log`);
    const lines = [JSON.stringify({ page: l.index, name: l.name, team: l.team, touch: l.touch, role: l.role, you: l.you }), ...l.welcomes.map((x) => JSON.stringify({ welcome: x })), ...l.frames.map((x) => JSON.stringify(x)), ...l.events.map((x) => JSON.stringify({ event: x })), ...l.tops.map((x) => JSON.stringify({ top: x })), ...l.screens.map((x) => JSON.stringify({ screen: x })), ...l.sent.map((x) => JSON.stringify({ sent: x })), ...l.intents.map((x) => JSON.stringify({ intent: x }))];
    writeFileSync(file, lines.join("\n") + "\n");
    const kills = l.events.filter((e) => e.ev.kind === OVER).reduce((a, e) => a + (e.ev.kills ?? 0), 0);
    say(`${l.name}: id ${l.you}, ${l.touch ? "touch" : "mouse"}, ${pg.overs} lives over, ${kills} kills, ${l.frames.length} ticks, ${l.sent.length} inputs sent, ${l.tops.length} top 10 reads, at most ${pg.maxBots} fill bots seen`);
  }
  const results = runChecks(
    pages.map((p) => p.log),
    args.scenario,
  );
  console.log(`\n${table(results)}\n`);
  code = exitCode(results);
  console.log(code === 0 ? "PASS" : "FAIL");
} catch (e) {
  console.error(`playtest failed: ${(e as Error).message}`);
  code = 1;
} finally {
  if (!stopping) {
    stopping = true;
    await shutdown();
  }
}
process.exit(code);
