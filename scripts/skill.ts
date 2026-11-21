// `bun run skill [--seeds 30] [--max 300]`: plays seeded arenas in-process with the policies in
// src/shared/arena/policies.ts and prints each gate's numbers: the aimer against the mover, late
// joiners against early ones, and the idle newcomer at every arena age. Exits 1 unless all three
// gates pass (PRD.md, "Skill is measured"). The work is in skill-lib.ts.
import { formatDropIn, formatSkill, parseSkillArgs, runDropIn, runSkill } from "./skill-lib";

const args = parseSkillArgs(process.argv.slice(2));
if (typeof args === "string") {
  console.error(args);
  process.exit(2);
}
const report = runSkill(args.seeds, args.max);
for (const line of formatSkill(report)) console.log(line);
const dropIn = runDropIn(args.seeds, args.max);
for (const line of formatDropIn(dropIn)) console.log(line);
const pass = report.pass && dropIn.latePass && dropIn.idlePass;
console.log(pass ? "all three gates PASS" : "a gate FAILED");
process.exit(pass ? 0 : 1);
