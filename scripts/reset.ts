// `bun run reset -- --yes`: deletes every run and player, for a clean top 10 before the stream
// (and to clear `load-` players after `bun run load`). Hidden names are kept. Without --yes it
// only says what it would do, and opens nothing.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, resetData } from "../src/server/db";

const args = process.argv.slice(2).filter((a) => a !== "--");
const path = join(process.env.DATA_DIR ?? "data", "app.db");
if (args.length !== 1 || args[0] !== "--yes") {
  console.error(`reset: deletes every run and player in ${path}; run again with --yes`);
  process.exit(1);
}
if (!existsSync(path)) {
  console.error(`reset: no database at ${path} (set DATA_DIR to the folder that holds app.db)`);
  process.exit(1);
}
const db = openDb(path);
try {
  const { runs, players } = resetData(db);
  // A running server needs no restart: its top 10 cache lasts 1 s, and a run started before the
  // reset can no longer be finished, because its start is gone (the end is a 404).
  console.log(
    `reset: deleted ${runs} run${runs === 1 ? "" : "s"} and ${players} player${players === 1 ? "" : "s"} (hidden names kept)`,
  );
} finally {
  db.close();
}
