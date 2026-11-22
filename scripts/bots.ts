// `bun run bots -- --url <base url> [--count 18] [--seconds 60] [--policy wander|mover|aimer|dasher]`:
// real WebSocket clients named bots-01, bots-02, ... (alternating teams) join the arena 25 ms
// apart and play, sending one input every 50 ms, for the given time: by default with the aimer
// policy (src/shared/arena/policies.ts), which aims, fires in bursts and respawns; `wander` walks
// and sweeps its aim without firing. Then it prints joins, the arenas used, messages received per
// second, lives ended and their median score, errors (error messages, failed connects, unexpected
// closes) and the server's tick p50/p95 and memory from /api/arena/stats, closes every socket.
// `--watchers <n>` (#79) then opens n start-screen watch sockets, which send nothing, and prints
// the KB/s each receives (mean and max); `--count 0 --watchers <n>` measures an empty server's demo
// arena. Every bot life is saved like a person's: point it only at a server with a scratch
// DATA_DIR. Not part of `bun run check`: it needs a running server. bots-lib.ts is tested.
//
// The budget gate (#89): each bot decodes its snapshots as a browser does (view.ts; one it cannot
// decode after its first keyframe is a `desync` error) and counts the payload bytes it receives
// after its welcome (WebSocket framing, 2 to 4 B a frame, is not counted; 1 KB = 1000 B). Its KB/s
// is taken over the second half of the run, when the bugs have ramped up to the arena's cap. The
// run prints a `budget:` line per gate and exits 1 on any miss: an error, a bot that never joined,
// stats unreachable, tick p95 not under 10 ms, or any bot over 40 KB/s (bots-lib.ts budgetVerdict).
// Bots see only what their view holds, as a player does, so what they observe is no longer
// `bun run skill`'s perfect information (the skill gates run on the simulation and are unaffected).
import { PROTOCOL_VERSION, TICK_MS } from "../src/shared/arena/constants";
import { POLICIES, createMemory, type PolicyInput, type PolicyMemory } from "../src/shared/arena/policies";
import { createRng } from "../src/shared/arena/rng";
import { ERROR, EVENT, OVER, SNAPSHOT, WELCOME, encodeHello, encodeInput, encodeWatch, parseServerMessage, utf8Bytes } from "../src/shared/arena/protocol";
import { createSnapshotReader } from "../src/shared/arena/view";
import type { ArenaStats } from "../src/server/arena/rooms";
import {
  USAGE,
  botName,
  botTeam,
  createObservationTracker,
  createTally,
  createWander,
  budgetVerdict,
  countBytes,
  exitCode,
  firstHalfKbps,
  formatSummary,
  rateStats,
  secondHalfKbps,
  parseBotsArgs,
  randomPlayerId,
  stepWander,
  wsUrl,
  type BotBytes,
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
  bytes: BotBytes;
  /** Decoded a keyframe since its welcome: from then on every snapshot must decode. */
  synced: boolean;
};

const tally = createTally();
const bots: Bot[] = [];
const rng = createRng(Date.now() | 0);
const url = wsUrl(args.url);
const started = performance.now();
/** The second half of the run starts here; bandwidth is measured from it. */
const midAt = started + (args.seconds * 1000) / 2;

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
    bytes: { first: 0, second: 0, welcomedAt: null },
    synced: false,
  };
  bots.push(bot);
  const read = createSnapshotReader();
  let opened = false;
  ws.addEventListener("open", () => {
    opened = true;
    ws.send(encodeHello(PROTOCOL_VERSION, botName(i), botTeam(i), randomPlayerId(), false));
  });
  ws.addEventListener("message", (e) => {
    tally.messages++;
    const raw = String(e.data);
    countBytes(bot.bytes, utf8Bytes(raw), performance.now(), midAt);
    const wire = parseServerMessage(raw);
    if (!wire) return;
    const m = read(wire);
    if (!m) {
      if (bot.synced) tally.errors.push("desync");
      bot.synced = false;
      return;
    }
    if (m.t === WELCOME) {
      tally.joins++;
      tally.arenas.add(m.arena);
      bot.you = m.you;
      bot.synced = false;
      bot.bytes.welcomedAt ??= performance.now();
      console.log(`${botName(i)} joined arena ${m.arena} as entity ${m.you}`);
    } else if (m.t === SNAPSHOT) {
      if (bot.you === null) return;
      bot.synced = true;
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
  const read = createSnapshotReader();
  ws.addEventListener("message", (e) => {
    const raw = String(e.data);
    const wire = parseServerMessage(raw);
    const m = wire && read(wire);
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
    tally.memory = stats.memory ?? null;
    tally.serverArenas = stats.arenas.length;
    console.log(
      `server: ${stats.players} players, ${stats.bots} fill bots and ${stats.watchers} watchers in ${stats.arenas.length} arena(s): ${stats.arenas.map((a) => `#${a.id} ${a.players}+${a.bots} bots, ${a.watchers} watching`).join("; ")}`,
    );
  } else tally.errors.push(`stats ${res.status}`);
} catch {
  tally.errors.push("stats unreachable");
}

clearInterval(inputs);
const ended = performance.now();
for (const bot of bots) {
  const r = secondHalfKbps(bot.bytes, midAt, ended);
  if (r !== null) tally.kbps.push(r);
  const f = firstHalfKbps(bot.bytes, midAt);
  if (f !== null) tally.kbpsFirst.push(f);
}
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
const misses = budgetVerdict({ errors: tally.errors.length, joins: tally.joins, count: args.count, tick, kbps: rateStats(tally.kbps) });
process.exit(exitCode(misses));
