// `bun run bench`: the frame-rate benchmark. Builds the game in bench mode (so `?stress` works)
// to a temp folder, serves it on localhost, and plays a 60 s stress run (150 bugs, every upgrade
// at its top level, the F readout on) in headless Chrome at a desktop and a phone size. The page
// records its own frames (loop.ts, `window.bugSwarmBench`); this prints the table a pull request
// needs, then measures the game-over screen's layout at phone portrait, landscape and desktop.
// PASS needs avg and worst 1 s at 58 fps or more at both sizes; FAIL exits 1.
//
// Chrome: CHROME_PATH, or the standard install location. `--shots <dir>` keeps a screenshot of
// each run (mid-run, readout showing) and each game-over layout. No dependencies: CDP over
// Bun's WebSocket. Needs a browser, so it isn't part of `bun run check`.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, sep } from "node:path";
import { saveNotice } from "../src/web/over";

const BUGS = 150;
const SKIP_MS = 5000;
const TARGET_FPS = 58;
const RUN_TIMEOUT_MS = 120_000;
const TOP_NAME = "W".repeat(16); // NAME_MAX wide characters: the widest a top-10 row gets

type Viewport = { label: string; width: number; height: number; dpr: number; mobile: boolean };
const RUNS: { run: Viewport; layouts: Viewport[] }[] = [
  {
    run: { label: "Desktop 1440x900", width: 1440, height: 900, dpr: 1, mobile: false },
    layouts: [{ label: "Desktop 1440x900", width: 1440, height: 900, dpr: 1, mobile: false }],
  },
  {
    run: { label: "Phone 390x844 @3x", width: 390, height: 844, dpr: 3, mobile: true },
    layouts: [
      { label: "Phone portrait 390x844", width: 390, height: 844, dpr: 3, mobile: true },
      { label: "Phone landscape 844x390", width: 844, height: 390, dpr: 3, mobile: true },
    ],
  },
];

const shotsArg = process.argv.indexOf("--shots");
const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : undefined;

function findChrome(): string | null {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
      const found = Bun.which(name);
      if (found) candidates.push(found);
    }
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** A minimal CDP session on one page target. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`CDP: could not connect to ${url}`));
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`CDP: ${msg.error.message}`));
    else p.resolve(msg.result);
  };
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string): Promise<any> => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}
type Session = Awaited<ReturnType<typeof connect>>;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(250);
  }
}

async function screenshot(cdp: Session, name: string) {
  if (!shotsDir) return;
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const file = join(shotsDir, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  console.log(`  screenshot: ${file}`);
}

type Row = {
  label: string;
  bugs: string;
  avg: number;
  worst: number;
  slow: number;
  /** When each frame over 20 ms ended, seconds into the run. */
  slowAt: number[];
  fxMax: number;
  draw: { avg: number; p99: number; max: number };
};

function summarise(label: string, rec: { frames: number[]; draws: number[]; bugs: number[]; fx: number[] }): Row {
  // Each frame's end time from the run's first frame; keep the frames from SKIP_MS on.
  const times: number[] = [];
  let t = 0;
  const keep: number[] = [];
  for (let i = 0; i < rec.frames.length; i++) {
    t += rec.frames[i]!;
    if (t >= SKIP_MS) {
      keep.push(i);
      times.push(t);
    }
  }
  if (keep.length < 2) throw new Error(`${label}: too few frames recorded`);
  const span = times[times.length - 1]! - times[0]!;
  const avg = ((keep.length - 1) / span) * 1000;
  // Worst sliding 1 s: the fewest frames ending in any 1 s window inside the measured span.
  let worst = Infinity;
  let j = 0;
  for (let i = 0; times[i]! + 1000 <= times[times.length - 1]!; i++) {
    while (j < times.length && times[j]! < times[i]! + 1000) j++;
    worst = Math.min(worst, j - i);
  }
  const draws = keep.map((i) => rec.draws[i]!).sort((a, b) => a - b);
  const bugs = keep.map((i) => rec.bugs[i]!);
  return {
    label,
    bugs: `${Math.min(...bugs)}-${Math.max(...bugs)}`,
    avg,
    worst,
    slow: keep.filter((i) => rec.frames[i]! > 20).length,
    slowAt: keep.flatMap((i, k) => (rec.frames[i]! > 20 ? [times[k]! / 1000] : [])),
    fxMax: Math.max(...keep.map((i) => rec.fx[i]!)),
    draw: {
      avg: draws.reduce((a, b) => a + b, 0) / draws.length,
      p99: draws[Math.min(draws.length - 1, Math.floor(draws.length * 0.99))]!,
      max: draws[draws.length - 1]!,
    },
  };
}

async function setViewport(cdp: Session, v: Viewport) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: v.width,
    height: v.height,
    deviceScaleFactor: v.dpr,
    mobile: v.mobile,
    screenOrientation: v.width > v.height ? { type: "landscapePrimary", angle: 90 } : { type: "portraitPrimary", angle: 0 },
  });
}

/** The longest line the game-over screen can show about saving. */
const LONGEST_NOTICE = saveNotice("rate-limited");

/** The game-over screen at `v`, with the worst case shown: the longest save alert added. */
async function measureLayout(cdp: Session, v: Viewport) {
  await setViewport(cdp, v);
  await wait(300);
  return cdp.evaluate(`(() => {
    const summary = document.querySelector(".over-summary");
    const hint = document.querySelector(".over-hint");
    const again = document.querySelector(".over-again");
    const button = document.querySelector(".over-again button");
    if (!summary || !hint || !again || !button) throw new Error("no game-over screen");
    if (!document.querySelector(".over-summary [role=alert]")) {
      const alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.className = "over-alert";
      alert.textContent = ${JSON.stringify(LONGEST_NOTICE)};
      summary.insertBefore(alert, again);
    }
    const rows = document.querySelectorAll(".over-board li").length;
    const chips = document.querySelectorAll("ul.over-upgrades li").length;
    const lastRow = document.querySelector(".over-board li:last-child");
    const race = document.querySelector(".over-race");
    return {
      hintBottom: Math.round(hint.getBoundingClientRect().bottom),
      buttonHeight: Math.round(button.getBoundingClientRect().height),
      boardBottom: lastRow ? Math.round(lastRow.getBoundingClientRect().bottom) : null,
      chipsTop: Math.round(document.querySelector(".over-upgrades").getBoundingClientRect().top),
      scrollHeight: document.scrollingElement.scrollHeight,
      scrollWidth: document.scrollingElement.scrollWidth,
      race: race ? Math.round(race.getBoundingClientRect().height) : null,
      innerWidth, innerHeight, rows, chips,
    };
  })()`);
}

const work = mkdtempSync(join(tmpdir(), "bug-swarm-bench-"));
const outDir = join(work, "dist");
const profile = join(work, "chrome");
let server: ReturnType<typeof Bun.serve> | null = null;
let chrome: ReturnType<typeof Bun.spawn> | null = null;
let cdp: Session | null = null;
let failed = false;

try {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("Chrome not found: install Google Chrome or set CHROME_PATH");

  console.log("Building in bench mode...");
  const build = Bun.spawnSync(["bun", "x", "vite", "build", "--mode", "bench", "--outDir", outDir, "--emptyOutDir", "--logLevel", "error"], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("vite build failed");

  // The built game, plus a fake top 10 (ten of the widest names) and six-figure team totals,
  // so the layout check sees the longest board and the race bar. Every other API call fails, as
  // with the server down; a stress run sends none.
  const root = normalize(outDir + sep);
  const top = { top: Array.from({ length: 10 }, (_, i) => ({ name: TOP_NAME, score: 99999 - i })) };
  const teams = { teams: { tabs: 123456, spaces: 98765 } };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/top") return Response.json(top);
      if (path === "/api/teams") return Response.json(teams);
      if (path.startsWith("/api/")) return new Response("bench: no API", { status: 503 });
      const file = normalize(join(outDir, path === "/" ? "index.html" : decodeURIComponent(path)));
      if (!file.startsWith(root) || !existsSync(file)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file));
    },
  });

  chrome = Bun.spawn(
    [
      chromePath,
      "--headless=new",
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
  const portFile = join(profile, "DevToolsActivePort");
  const port = await until("Chrome's DevTools port", 20_000, async () => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0]!.trim());
  const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { Browser: string };
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("Chrome opened no page");
  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  const rows: Row[] = [];
  const layouts: { label: string; m: any }[] = [];
  for (const { run, layouts: sizes } of RUNS) {
    console.log(`${run.label}: 60 s stress run...`);
    // The arena is fixed when the run starts, so the size comes first.
    await setViewport(cdp, run);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.port}/?stress=${BUGS}` });
    await until("the stress run to start", 20_000, () => cdp!.evaluate("!!window.bugSwarmBench"));
    // F: the readout is on for the whole measurement, so its cost is in the numbers.
    for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, code: "KeyF", key: "f", windowsVirtualKeyCode: 70 });
    // Inside the skipped first SKIP_MS: a screenshot takes long enough to cost a frame.
    await wait(3000);
    await screenshot(cdp, `run-${run.width}x${run.height}`);
    await until("the stress run to end", RUN_TIMEOUT_MS, () => cdp!.evaluate("window.bugSwarmBench.done"));
    const rec = await cdp.evaluate(`(() => {
      const b = window.bugSwarmBench;
      const take = (a) => Array.from(a.subarray(0, b.count));
      return { frames: take(b.frames), draws: take(b.draws), bugs: take(b.bugs), fx: take(b.fx) };
    })()`);
    rows.push(summarise(run.label, rec));
    await until("the game-over screen", 20_000, () => cdp!.evaluate("!!document.querySelector('.over-board li')"));
    for (const v of sizes) {
      const m = await measureLayout(cdp, v);
      layouts.push({ label: v.label, m });
      await screenshot(cdp, `over-${v.width}x${v.height}`);
    }
  }

  const f1 = (n: number) => n.toFixed(1);
  const f2 = (n: number) => n.toFixed(2);
  console.log(`\n${version.Browser}, headless (new), ${BUGS} bugs, every upgrade at L2, F readout on; stats from ${SKIP_MS / 1000} s to the end of the 60 s run\n`);
  console.log("| Run | Bugs | Avg fps | Worst 1 s | Frames > 20 ms | Effects max | `draw()` avg / p99 / max |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(`| ${r.label} | ${r.bugs} | ${f1(r.avg)} | ${r.worst} | ${r.slow} | ${r.fxMax} | ${f2(r.draw.avg)} / ${f1(r.draw.p99)} / ${f1(r.draw.max)} ms |`);
  }
  for (const r of rows) if (r.slowAt.length) console.log(`${r.label}: frames over 20 ms ended at ${r.slowAt.map((s) => `${s.toFixed(1)} s`).join(", ")}`);
  console.log("\nGame-over layout (4 upgrades at L2, 10 top-10 rows, the team race, the too-many-runs alert added):\n");
  console.log("| Viewport | Upgrade chips | Top-10 rows | Race bar height | Play again height | Hint bottom | Last row bottom | Page height | Fits |");
  console.log("|---|---|---|---|---|---|---|---|---|");
  // "Play again" is a touch target, so it must be at least 44 px tall.
  const fit = (m: any) => m.race !== null && m.buttonHeight >= 44 && m.hintBottom <= m.innerHeight && m.scrollHeight <= m.innerHeight && m.scrollWidth <= m.innerWidth;
  for (const { label, m } of layouts) {
    const fits = fit(m);
    if (!fits) failed = true;
    console.log(
      `| ${label} | ${m.chips} | ${m.rows} | ${m.race ?? "missing"} | ${m.buttonHeight} | ${m.hintBottom} | ${m.boardBottom} | ${m.scrollHeight} / ${m.innerHeight} | ${fits ? "yes" : "NO"} |`,
    );
  }
  const slow = rows.filter((r) => r.avg < TARGET_FPS || r.worst < TARGET_FPS);
  if (slow.length) failed = true;
  console.log(
    `\n${failed ? "FAIL" : "PASS"}: ${slow.length ? `under ${TARGET_FPS} fps at ${slow.map((r) => r.label).join(", ")}` : `${TARGET_FPS}+ fps avg and worst 1 s at both sizes`}${
      layouts.some((l) => !fit(l.m)) ? "; the game-over screen doesn't fit (or has no race bar, or Play again is under 44 px)" : ""
    }`,
  );
} catch (err) {
  failed = true;
  console.error(`bench: ${err instanceof Error ? err.message : err}`);
} finally {
  if (cdp) {
    await cdp.send("Browser.close").catch(() => {});
    cdp.close();
  }
  if (chrome) {
    // Only the Chrome this script started, by its own handle; wait for it so its profile unlocks.
    const exited = await Promise.race([chrome.exited.then(() => true), wait(10_000).then(() => false)]);
    if (!exited) {
      chrome.kill();
      await chrome.exited;
    }
  }
  server?.stop(true);
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(work, { recursive: true, force: true });
      break;
    } catch {
      await wait(500); // Windows can hold the profile a moment after Chrome exits
    }
  }
}
process.exit(failed ? 1 : 0);
