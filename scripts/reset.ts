// `bun run reset -- --yes`: deletes every run (every saved arena life) and player, for a clean top
// 10 before the stream. Hidden names are kept. Without --yes it
// only says what it would do, and opens nothing.
// The logic is `resetCommand` in `admin-lib.ts`, which `bun test` covers.
import { finish, resetCommand } from "./admin-lib";

finish(resetCommand(process.argv.slice(2), process.env.DATA_DIR ?? "data"));
