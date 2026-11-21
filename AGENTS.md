# Bug Swarm

A real-time multiplayer arena shooter for a livestream audience (release 2): aim, dodge and revive teammates in shared arenas, and climb a shared top 10 and a Tabs vs Spaces team race. Release 1 (single-player, auto-fire) is on the `release-1` branch.

- What we're building and why: `PRD.md` (release 1's: `docs/prd-release-1.md`)
- What's in and out of scope: `direction.md`
- Stack, how it runs, and the shape: `architecture.md` (the arena: "Arena (release 2)")
- Conventions every change follows: `engineering.md`

Quick commands:
- `bun install` then `bun run dev`
- `bun run check` must pass before any pull request.
- `bun run pacing` prints how long runs last with each upgrade order, and fails if balance is off. `bun run pacing --broad` plays more seeds; the server's score caps are measured from it.
- `bun run bench` measures the frame rate at 150 bugs in headless Chrome. `bun run stats` prints the bet's numbers. `bun run hide "<name>"` hides a name from every board.
- `bun run load -- --url <base url> [--players 500] [--seconds 60]` load-tests a running server (start it with `RUN_STARTS_PER_WINDOW` raised; see `architecture.md`). `bun run reset -- --yes` deletes every run and player before the stream.
- Release 2 adds (as items land): `bun run bots -- --url <base> --count <n> --seconds <s>` (WebSocket bots, playing the aimer; their lives save, so only against a scratch `DATA_DIR`), `bun run skill` (the skill gate).
- Proof made while working (screenshots, logs, probe scripts) goes in `.evidence/<issue number>/`, never outside the checkout.
