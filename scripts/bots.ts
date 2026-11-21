// `bun run bots -- --url <base url> [--count 18] [--seconds 60]`: real WebSocket clients named
// bots-01, bots-02, ... (alternating teams) join the arena 25 ms apart, wander and sweep their aim,
// sending one input every 50 ms, for the given time. Then it prints joins, the arenas used,
// messages received per second, errors (error messages, failed connects, unexpected closes) and
// the server's tick p50/p95 from /api/arena/stats, closes every socket, and exits 1 on any error.
// Not part of `bun run check`: it needs a running server. bots-lib.ts, its pure half, is tested.
import { PROTOCOL_VERSION, TICK_MS } from "../src/shared/arena/constants";
import { createRng } from "../src/shared/arena/rng";
import { ERROR, SNAPSHOT, WELCOME, encodeHello, encodeInput, parseServerMessage } from "../src/shared/arena/protocol";
import type { ArenaStats } from "../src/server/arena/rooms";
import {
  USAGE,
  botName,
  botTeam,
  createTally,
  createWander,
  formatSummary,
  parseBotsArgs,
  randomPlayerId,
  stepWander,
  wsUrl,
  type BotsArgs,
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

type Bot = { ws: WebSocket; you: number | null; x: number; y: number; seq: number; wander: Wander; closing: boolean; closed: Promise<void> };

const tally = createTally();
const bots: Bot[] = [];
const rng = createRng(Date.now() | 0);
const url = wsUrl(args.url);

function open(i: number): void {
  const ws = new WebSocket(url);
  let resolveClosed: () => void = () => {};
  const bot: Bot = { ws, you: null, x: 0, y: 0, seq: 0, wander: createWander(), closing: false, closed: new Promise((r) => (resolveClosed = r)) };
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
      for (const p of m.p) {
        if (p[0] !== bot.you) continue;
        bot.x = p[1];
        bot.y = p[2];
      }
    } else if (m.t === ERROR) {
      tally.errors.push(`error ${m.code}`);
    }
  });
  ws.addEventListener("close", (e) => {
    if (!bot.closing) tally.errors.push(opened ? `close ${e.code}` : "connect failed");
    resolveClosed();
  });
}

const started = performance.now();
for (let i = 1; i <= args.count; i++) {
  open(i);
  await Bun.sleep(JOIN_GAP_MS);
}

const out = { mx: 0, my: 0, aim: 0 };
const inputs = setInterval(() => {
  for (const bot of bots) {
    if (bot.you === null || bot.ws.readyState !== WebSocket.OPEN) continue;
    stepWander(bot.wander, rng, bot.x, bot.y, out);
    bot.ws.send(encodeInput({ seq: ++bot.seq, mx: out.mx, my: out.my, aim: out.aim, fire: false, dash: false }));
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
    console.log(`server: ${stats.players} players in ${stats.arenas.length} arena(s): ${stats.arenas.map((a) => `#${a.id} ${a.players}`).join(", ")}`);
  } else tally.errors.push(`stats ${res.status}`);
} catch {
  tally.errors.push("stats unreachable");
}

clearInterval(inputs);
for (const bot of bots) {
  bot.closing = true;
  bot.ws.close();
}
await Promise.race([Promise.all(bots.map((b) => b.closed)), Bun.sleep(5000)]);

for (const line of formatSummary(args, tally, seconds, tick)) console.log(line);
process.exit(tally.errors.length > 0 ? 1 : 0);
