// `bun run hide "<name>"`: hides a name (any case) from the top 10. The server caches the
// top 10 for one second, so the name is gone from every screen within a few seconds.
import { join } from "node:path";
import { hideName, openDb } from "../src/server/db";

const name = process.argv.slice(2).filter((a) => a !== "--").join(" ").trim();
if (!name) {
  console.error('usage: bun run hide "<name>"');
  process.exit(1);
}
const db = openDb(join(process.env.DATA_DIR ?? "data", "app.db"));
try {
  const key = hideName(db, name, new Date());
  console.log(`hidden: ${key}`);
} finally {
  db.close();
}
