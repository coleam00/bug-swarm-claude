import { join } from "node:path";
import { openDb } from "./db";
import { listenConfig } from "./listen";
import { buildIdFrom, startServer } from "./serve";

// Production mode: one process serves the API, the built game from dist/ (the start screen and the
// arena at /), the stream board at /board and the arena's WebSocket at /ws (serve.ts).
const { port, hostname } = listenConfig(process.env);
const dataDir = process.env.DATA_DIR ?? "data";
const db = openDb(join(dataDir, "app.db"));
startServer({ port, hostname, db, distDir: "dist", buildId: buildIdFrom(process.env, Date.now()) });
console.log(`App on http://${hostname}:${port}`);
