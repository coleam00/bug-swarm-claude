// `bun run skill [--seeds 30] [--late-seeds 240] [--max 300]` (`--late-seeds 60`: the quick mode): plays seeded arenas in-process with
// the policies in src/shared/arena/policies.ts and prints each gate's numbers: the aimer against
// the mover, aiming late joiners against early ones (the mover's late ratio printed, not gated),
// and the idle newcomer at every arena age, plus an info line placing the server's fill bot between
// the mover and the aimer (#66, not a gate), and each policy's pickups a life (#73: taken in all and by
// id, shield blocks, laser hits, bomb kills, drone kills), and how long 4 aimers (and 1) take to kill
// the wave-5 hive queen (#85, reported, not a gate). Pickups drop in every gate's arenas. Exits 1
// unless all three gates pass (PRD.md, "Skill is measured"). The work is in skill-lib.ts.
import { QUEEN_AIMERS, QUEEN_SEEDS, formatDropIn, formatFill, formatQueen, formatSkill, parseSkillArgs, runDropIn, runFill, runQueen, runSkill } from "./skill-lib";

const args = parseSkillArgs(process.argv.slice(2));
if (typeof args === "string") {
  console.error(args);
  process.exit(2);
}
const report = runSkill(args.seeds, args.max);
for (const line of formatSkill(report)) console.log(line);
// The server's fill bots (#66): reported, not a gate.
console.log(formatFill(runFill(args.seeds, args.max, report)));
const dropIn = runDropIn(args.seeds, args.lateSeeds, args.max);
for (const line of formatDropIn(dropIn)) console.log(line);
// The hive queen (#85): how long aimers take to bring down the wave-5 queen. Reported, not a gate.
console.log(formatQueen(runQueen(QUEEN_SEEDS, QUEEN_AIMERS)));
console.log(formatQueen(runQueen(QUEEN_SEEDS, 1)));
const pass = report.pass && dropIn.latePass && dropIn.idlePass;
console.log(pass ? "all three gates PASS" : "a gate FAILED");
process.exit(pass ? 0 : 1);
