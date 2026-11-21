// `bun run hide "<name>"`: hides a name (any case) from the top 10 and its runs from the team
// totals. The server caches both for one second and the game polls them every 4, so the name
// is gone from every screen within 5 seconds. It says how many players have the name, so a typo doesn't pass for a hide.
// The logic is `hideCommand` in `admin-lib.ts`, which `bun test` covers.
import { finish, hideCommand } from "./admin-lib";

finish(hideCommand(process.argv.slice(2), process.env.DATA_DIR ?? "data", new Date()));
