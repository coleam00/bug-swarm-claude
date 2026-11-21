// `bun run skill [--seeds 30] [--max 300]`: plays seeded arenas in-process with the policies in
// src/shared/arena/policies.ts and prints each one's median score and life length. Exits 1 when
// the gate fails (PRD.md, "Skill is measured"). The work is in skill-lib.ts.
import { formatSkill, parseSkillArgs, runSkill } from "./skill-lib";

const args = parseSkillArgs(process.argv.slice(2));
if (typeof args === "string") {
  console.error(args);
  process.exit(2);
}
const report = runSkill(args.seeds, args.max);
for (const line of formatSkill(report)) console.log(line);
process.exit(report.pass ? 0 : 1);
