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
- `bun run bots -- --url <base> --count <n> --seconds <s>` load-tests a running server with WebSocket bots playing the aimer (their lives save, so only against a scratch `DATA_DIR`). `bun run skill` runs the three skill gates (`direction.md`, `PRD.md`).
- Proof made while working (screenshots, logs, probe scripts) goes in `.evidence/<issue number>/`, never outside the checkout.
