# Architecture

## Stack
- Bun (runtime, package manager, test runner), TypeScript strict, Vite for the browser build, Canvas 2D for the game, Hono on Bun for a small API, SQLite through `bun:sqlite` for runs and scores.
- Why: the bootcamp's supported stack, with the same commands on Windows, macOS and Linux. A game loop needs no UI framework; the server exists for the shared leaderboard and the bet.
- The scaffolded React screen stays only as a thin shell for name entry and the game-over screen around the canvas. No React in the game loop.

## How it runs
- Install: `bun install`
- Develop: `bun run dev` (Vite dev server for the game, with the API server beside it)
- Start (production mode): `bun run start`: one Bun process serves the API, the built game from `dist/`, and `/board`, on `PORT` (default 3000).
- Container: `Dockerfile` builds the game and runs `bun run start`; `DATA_DIR` must be a persistent volume.
- Health: `GET /health` answers `200 ok` once the app is ready.
- Test everything: `bun run check` (`tsc --noEmit`, then `bun test`). CI runs exactly this.
- The bet's command: `bun run stats`. Moderation: `bun run hide "<name>"`. Load test (Phase 3): `bun run load`.

## Shape
- Browser game -> HTTP API -> one SQLite file.
- `src/web/App.tsx`: name and team entry, the canvas, the game-over screen.
- `src/web/game/`: the game in plain TypeScript.
  - The simulation (robot, bugs, shots, hits, upgrades, spawn ramp) is pure: it advances by a time step from input and state, with no canvas, DOM or clock access, so `bun test` covers it.
  - The loop runs on `requestAnimationFrame` with a fixed time step and draws the state to the canvas, scaled to the screen in portrait or landscape.
  - Input: touch drag (the robot moves toward the finger), WASD and arrow keys, mouse steering, 1-3 or tap to pick an upgrade, F for the frame-rate readout on desktop.
  - The API client starts a run and submits its score without blocking the loop; failures are logged and the game-over screen says the score wasn't saved.
- `src/web/board/`: the `/board` page for the stream (top 10 and team totals, big type, polls the API).
- `src/server/app.ts`: `/health`, and routes under `/api`: start a run (returns a run id), finish a run (score, squashes, upgrades, device type), top 10, a player's best, team totals.
- `src/server/db.ts`: the SQLite file, its tables, `EVENT_TYPES` (`run_started`, `run_ended`) and `TEAMS` (`tabs`, `spaces`). Schema changes are additive.
- `src/server/rules.ts`: name rules and score plausibility (max points per second of real elapsed time), both pure and tested.
- `src/server/blocked-words.ts`: the blocked-word list.
- `src/server/main.ts`: production entry; reads `PORT` and `DATA_DIR` (default `data/`).
- `scripts/stats.ts`, `scripts/hide.ts`, `scripts/load.ts`.
- Tests are `*.test.ts` beside the code.

## Data
- **Player:** a random id the browser creates on first visit and keeps in local storage, with a name and (Phase 3) a team. No account.
- **Run:** `run_started` (run id, player id, server time) and `run_ended` (run id, score, squashes, seconds, upgrades, touch or not). A run with no `run_ended` was abandoned.
- **Hidden names:** a table the top 10 and the board filter on; `bun run hide` adds to it.
- **Top 10 and team totals:** computed from finished, non-hidden runs, cached for 1 second so hundreds of clients polling cost one query a second.

## Hosting
- Railway, from the `Dockerfile`, with a volume mounted at `DATA_DIR` and GitHub auto-deploy on `main`, so a merged change reaches players within minutes. One instance (SQLite needs one long-running process with a disk). The owner sets up the Railway project; the app only has to honor `PORT` and `DATA_DIR`.

## Boundaries
- No API keys and no outside services. The app starts and `bun run check` passes with no `.env`.
- Public on the internet during the stream: the API accepts only well-formed requests with capped sizes, at most one score per run id, scores that pass the plausibility check, and at most 30 run starts per IP per 10 minutes.
- Nothing the player does depends on a server response; a run plays with the API down.

## Decisions deferred
- Spawn rates, bug speed and upgrade strength: start from the PRD's targets (idle player loses within 60 s, typical run 1 to 3 minutes) and tune after Phase 2.
- Art: drawn in code on the canvas (see `direction.md`, "The look"). Effects live in `src/web/game/fx/` (particles, trails, screen shake, floating text), pooled so they allocate nothing per frame.
