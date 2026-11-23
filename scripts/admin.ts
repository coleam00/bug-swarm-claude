// `bun run admin -- --url <base> stats [--since <ISO>] [--until <ISO>] | hide "<name>" | reset --yes`:
// the owner's stats, hide and reset against a running server (the live Railway service), through
// its /api/admin/* routes (src/server/admin.ts, #110). The service must have ADMIN_TOKEN set (16+
// characters), and your shell the same value: the token is read from the environment, never from
// an argument, and never printed. Plain http is refused except to localhost.
// The logic is `adminCommand` in `admin-cli-lib.ts`, which `bun test` covers.
import { adminCommand } from "./admin-cli-lib";
import { finish } from "./admin-lib";

finish(await adminCommand(process.argv.slice(2), process.env, fetch));
