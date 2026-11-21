// `bun run hide "<name>"`: hides a name (any case) from the top 10 and its runs from the team
// totals. The server caches both for one second and the game polls them every 4, so the name
// is gone from every screen within 5 seconds. It says how many players have the name, so a typo doesn't pass for a hide.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hideName, openDb } from "../src/server/db";

const name = process.argv.slice(2).filter((a) => a !== "--").join(" ").trim();
if (!name) {
  console.error('usage: bun run hide "<name>"');
  process.exit(1);
}
const path = join(process.env.DATA_DIR ?? "data", "app.db");
if (!existsSync(path)) {
  console.error(`hide: no database at ${path} (set DATA_DIR to the folder that holds app.db)`);
  process.exit(1);
}
const db = openDb(path);
try {
  const { key, players } = hideName(db, name, new Date());
  if (players === 0) console.log(`hidden: ${key} (no player has this name yet; check the spelling)`);
  else console.log(`hidden: ${key} (${players} player${players === 1 ? "" : "s"})`);
} finally {
  db.close();
}
