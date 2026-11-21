// `bun run hide "<name>"`: hides a name (any case) from the top 10 and its runs from the team
// totals. The server caches both for one second and the game polls them every 4, so the name
// is gone from every screen within 5 seconds. A running server also checks its live arenas for
// hidden names every 2 seconds (src/server/arena/sockets.ts), so a player with that name is kicked
// back to the start screen within 3 seconds ("Pick a different name"). It says how many players
// have the name, so a typo doesn't pass for a hide.
// The logic is `hideCommand` in `admin-lib.ts`, which `bun test` covers.
import { finish, hideCommand } from "./admin-lib";

finish(hideCommand(process.argv.slice(2), process.env.DATA_DIR ?? "data", new Date()));
