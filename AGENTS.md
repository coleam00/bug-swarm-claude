# Bug Swarm

A real-time multiplayer arena shooter for a livestream audience (release 2): aim, dodge and revive teammates in shared arenas, and climb a shared top 10 and a Tabs vs Spaces team race. Release 1 (single-player, auto-fire) is on the `release-1` branch.

- What we're building and why: `PRD.md` (release 1's: `docs/prd-release-1.md`)
- What's in and out of scope: `direction.md`
- Stack, how it runs, and the shape: `architecture.md` (the arena: "Arena (release 2)")
- Conventions every change follows: `engineering.md`

Quick commands:
- `bun install` then `bun run dev`
- `bun run check` must pass before any pull request.
- The game is at `/` (start screen, then the arena; `/arena` redirects there) and the stream board at `/board`.
- `bun run stats` prints the bet's numbers (a run is one arena life). `bun run hide "<name>"` hides a name from every board and kicks it from any live arena within 5 seconds. `bun run reset -- --yes` deletes every run and player before the stream.
- `bun run bots -- --url <base> --count <n> --seconds <s>` load-tests a running server with WebSocket bots playing the aimer (their lives save, so only against a scratch `DATA_DIR`), prints a `budget:` line per gate (tick p95 under 10 ms, at most 40 KB/s per player, 0 errors) and exits non-zero on a miss (`docs/arena-load.md`); `--watchers <n>` adds start-screen watchers and prints the KB/s each receives (`--count 0` watches an empty server's demo arena). `bun run skill` runs the three skill gates (`direction.md`, `PRD.md`), the late-joiner gate on 240 seeds (about a minute); `bun run skill --late-seeds 60` is a quick look, not the verdict. It also reports how long 4 aimers take to kill the wave-5 hive queen (not a gate). `BUG_SWARM_START_WAVE=5` on a scratch server opens arenas 10 s before the hive queen, for evidence only.
- `bun run playtest -- --url <base> [--players 4] [--seconds 90] [--scenario basic|revive]` puts several headless Chrome players (desktop and touch phones) in one arena of a running server, plays them through real mouse, keyboard and touch input, and prints a pass/fail table of whether their screens agreed; screenshots and logs go to `.evidence/playtest/`. Their lives save, so only against a scratch `DATA_DIR`. Not part of `bun run check`.
- Proof made while working (screenshots, logs, probe scripts) goes in `.evidence/<issue number>/`, never outside the checkout.
