// `bun run pacing`: how long runs last, idle and for a realistic mover through each upgrade
// order, over seeds 0-49 and both screen shapes. Pure simulation, no browser. Exits 1 if a target fails.
// `bun run pacing --broad` plays seeds 0-124 instead (2,000 mover runs); the server's
// plausibility caps in src/server/rules.ts are measured from it.
import { pacing, playAll, RUN_CAP, SHAPES, squashRates, type Run, type Stats } from "../src/web/game/pacing";

const args = process.argv.slice(2);
if (args.some((a) => a !== "--broad")) {
  console.error("usage: bun run pacing [--broad]");
  process.exit(2);
}
const broad = args.includes("--broad");

const seeds = Array.from({ length: broad ? 125 : 50 }, (_, i) => i);
const runs = playAll(seeds);
const result = pacing(seeds, runs);
const rates = squashRates(runs);

const num = (v: number) => v.toFixed(0).padStart(4);
const line = (name: string, s: Stats) =>
  `${name.padEnd(22)} ${num(s.median)} ${num(s.p10)} ${num(s.p90)} ${num(s.max)} ${String(s.unfinished).padStart(11)}`;
const where = (r: Run) => `${r.group}, seed ${r.seed}, arena ${SHAPES[r.shape]!.w}x${SHAPES[r.shape]!.h}`;

console.log(`Run seconds, seeds 0-${seeds.length - 1}, screens 390x844 and 1280x800 (arenas 450x800 and 759x474; did not end = still going at ${RUN_CAP} s)`);
console.log(`${"group".padEnd(22)}  med  p10  p90  max  did-not-end`);
console.log(line("idle", result.idle));
for (const [name, s] of Object.entries(result.orders)) console.log(line(name, s));
console.log(line("mover overall", result.overall));
console.log("");
const m = rates.maxRateRun.result;
console.log(`Most squashes per second: ${rates.maxRate.toFixed(3)} (${m.squashes} in ${m.seconds.toFixed(2)} s, score ${m.score}; ${where(rates.maxRateRun)})`);
console.log(`Longest run: ${rates.longest.result.seconds.toFixed(2)} s (${where(rates.longest)})`);
console.log("");
for (const t of result.targets) console.log(`${t.ok ? "PASS" : "FAIL"}  ${t.label}`);
if (!result.targets.every((t) => t.ok)) process.exit(1);
