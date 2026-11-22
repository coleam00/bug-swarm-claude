// `bun run bots -- --url <base url> [--count 18] [--seconds 60] [--policy wander|mover|aimer|dasher]`:
// real WebSocket clients named bots-01, bots-02, ... (alternating teams) join the arena 25 ms
// apart and play, sending one input every 50 ms, for the given time: by default with the aimer
// policy (src/shared/arena/policies.ts), which aims, fires in bursts and respawns; `wander` walks
// and sweeps its aim without firing. Then it prints joins, the arenas used, messages received per
// second, lives ended and their median score, errors (error messages, failed connects, unexpected
// closes) and the server's tick p50/p95 from /api/arena/stats, closes every socket, and exits 1 on
// any error. `--watchers <n>` (#79) then opens n start-screen watch sockets, which send nothing,
// and prints the KB/s each receives (mean and max); `--count 0 --watchers <n>` measures an empty
// server's demo arena. Every bot life is saved like a person's: point it only at a server with a scratch
// DATA_DIR. Not part of `bun run check`: it needs a running server. bots-lib.ts is tested.
import { PROTOCOL_VERSION, TICK_MS } from "../src/shared/arena/constants";
import { POLICIES, createMemory, type PolicyInput, type PolicyMemory } from "../src/shared/arena/policies";
import { createRng } from "../src/shared/arena/rng";
import { ERROR, EVENT, OVER, SNAPSHOT, WELCOME, encodeHello, encodeInput, encodeWatch, parseServerMessage, utf8Bytes } from "../src/shared/arena/protocol";
import type { ArenaStats } from "../src/server/arena/rooms";
import {
  USAGE,
  botName,
  botTeam,
  createObservationTracker,
  createTally,
  createWander,
  formatSummary,
  parseBotsArgs,
  randomPlayerId,
  stepWander,
  wsUrl,
  type BotsArgs,
  type ObservationTracker,
  type Wander,
} from "./bots-lib";

const JOIN_GAP_MS = 25;

let args: BotsArgs;
try {
  args = parseBotsArgs(process.argv.slice(2));
} catch (err) {
  console.error(`bots: ${err instanceof Error ? err.message : String(err)}`);
  console.error(USAGE);
  process.exit(1);
}

type Bot = {
  ws: WebSocket;
  you: number | null;
  x: number;
  y: number;
  seq: number;
  wander: Wander;
  seen: ObservationTracker;
  memory: PolicyMemory;
  closing: boolean;
  closed: Promise<void>;
};

const tally = createTally();
const bots: Bot[] = [];
const rng = createRng(Date.now() | 0);
const url = wsUrl(args.url);

function open(i: number): void {
  const ws = new WebSocket(url);
  let resolveClosed: () => void = () => {};
  const bot: Bot = {
    ws,
    you: null,
    x: 0,
    y: 0,
    seq: 0,
    wander: createWander(),
    seen: createObservationTracker(),
    memory: createMemory(),
    closing: false,
    closed: new Promise((r) => (resolveClosed = r)),
  };
  bots.push(bot);
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    ws.send(encodeHello(PROTOCOL_VERSION, botName(i), botTeam(i), randomPlayerId(), false));
  });
  ws.addEventListener("message", (e) => {
    tally.messages++;
    const m = parseServerMessage(e.data);
    if (!m) return;
    if (m.t === WELCOME) {
      tally.joins++;
      tally.arenas.add(m.arena);
      bot.you = m.you;
      console.log(`${botName(i)} joined arena ${m.arena} as entity ${m.you}`);
    } else if (m.t === SNAPSHOT) {
      if (bot.you === null) return;
      bot.seen.update(m, bot.you);
      bot.x = bot.seen.obs.self.x;
      bot.y = bot.seen.obs.self.y;
    } else if (m.t === EVENT && m.kind === OVER) {
      tally.lives.push(m.score ?? 0);
    } else if (m.t === ERROR) {
      tally.errors.push(`error ${m.code}`);
    }
  });
  ws.addEventListener("close", (e) => {
    if (!bot.closing) tally.errors.push(opened ? `close ${e.code}` : "connect failed");
    resolveClosed();
  });
}

/** The watch sockets: each counts the bytes it receives from its first welcome. */
const watchers: { ws: WebSocket; closing: boolean; closed: Promise<void>; bytes: number; since: number | null }[] = [];

function openWatcher(): void {
  const ws = new WebSocket(url);
  let resolveClosed: () => void = () => {};
  const w = { ws, closing: false, closed: new Promise<void>((r) => (resolveClosed = r)), bytes: 0, since: null as number | null };
  watchers.push(w);
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    ws.send(encodeWatch(PROTOCOL_VERSION));
  });
  ws.addEventListener("message", (e) => {
    const raw = String(e.data);
    const m = parseServerMessage(raw);
    if (m?.t === WELCOME && w.since === null) {
      w.since = performance.now();
      console.log(`watcher ${watchers.indexOf(w) + 1} watching arena ${m.arena}`);
      return;
    }
    if (w.since !== null) w.bytes += utf8Bytes(raw);
    if (m?.t === ERROR) tally.errors.push(`watcher error ${m.code}`);
  });
  ws.addEventListener("close", (e) => {
    if (!w.closing) tally.errors.push(opened ? `watcher close ${e.code}` : "watcher connect failed");
    resolveClosed();
  });
}

const started = performance.now();
for (let i = 1; i <= args.count; i++) {
  open(i);
  await Bun.sleep(JOIN_GAP_MS);
}
for (let i = 0; i < args.watchers; i++) {
  openWatcher();
  await Bun.sleep(JOIN_GAP_MS);
}

const out: PolicyInput = { mx: 0, my: 0, aim: 0, fire: false, dash: false };
const inputs = setInterval(() => {
  for (const bot of bots) {
    if (bot.you === null || bot.ws.readyState !== WebSocket.OPEN) continue;
    if (args.policy === "wander") {
      stepWander(bot.wander, rng, bot.x, bot.y, out);
      out.fire = false;
      out.dash = false;
    } else POLICIES[args.policy](bot.seen.obs, bot.memory, rng, out);
    bot.ws.send(encodeInput({ seq: ++bot.seq, mx: out.mx, my: out.my, aim: out.aim, fire: out.fire, dash: out.dash }));
  }
}, TICK_MS);

await Bun.sleep(Math.max(0, args.seconds * 1000 - (performance.now() - started)));
const seconds = (performance.now() - started) / 1000;

let tick: ArenaStats["tick"] | null = null;
try {
  const res = await fetch(`${args.url}/api/arena/stats`, { signal: AbortSignal.timeout(5000) });
  if (res.ok) {
    const stats = (await res.json()) as ArenaStats;
    tick = stats.tick;
    console.log(
      `server: ${stats.players} players, ${stats.bots} fill bots and ${stats.watchers} watchers in ${stats.arenas.length} arena(s): ${stats.arenas.map((a) => `#${a.id} ${a.players}+${a.bots} bots, ${a.watchers} watching`).join("; ")}`,
    );
  } else tally.errors.push(`stats ${res.status}`);
} catch {
  tally.errors.push("stats unreachable");
}

clearInterval(inputs);
const ended = performance.now();
for (const w of watchers) if (w.since !== null) tally.watchers.push({ bytes: w.bytes, seconds: (ended - w.since) / 1000 });
for (const bot of bots) {
  bot.closing = true;
  bot.ws.close();
}
for (const w of watchers) {
  w.closing = true;
  w.ws.close();
}
await Promise.race([Promise.all([...bots.map((b) => b.closed), ...watchers.map((w) => w.closed)]), Bun.sleep(5000)]);

for (const line of formatSummary(args, tally, seconds, tick)) console.log(line);
process.exit(tally.errors.length > 0 ? 1 : 0);
