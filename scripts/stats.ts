// `bun run stats [-- --since <ISO> --until <ISO>]`: prints the PRD's bet signal, exactly four
// lines, the same format whether or not any data exists yet (zeros on a fresh clone, and no
// database is created). `--since` is inclusive and `--until` exclusive, on the run's end time.
// The logic is `statsCommand` in `admin-lib.ts`, which `bun test` covers.
import { finish, statsCommand } from "./admin-lib";

finish(statsCommand(process.argv.slice(2), process.env.DATA_DIR ?? "data"));
