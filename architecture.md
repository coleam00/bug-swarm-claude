# Architecture

## Stack
- Bun (runtime, package manager, test runner), TypeScript strict, Vite for the browser build, Canvas 2D for the game, Hono on Bun for a small API, SQLite through `bun:sqlite` for runs and scores.
- Why: the bootcamp's supported stack, with the same commands on Windows, macOS and Linux. A game loop needs no UI framework; the server exists for the shared leaderboard and the bet.
- The scaffolded React screen stays only as a thin shell for name entry and the game-over screen around the canvas. No React in the game loop.

## How it runs
- Install: `bun install`
- Develop: `bun run dev` (Vite dev server for the game, with the API server beside it)
- Start (production mode): `bun run start`: one Bun process serves the API, the built game from `dist/`, and `/board`, on `PORT` (default 3000).
- Container: `Dockerfile` builds the game and runs `bun run start` with `NODE_ENV=production`, which makes the server listen on all interfaces; everywhere else it listens on localhost only. `DATA_DIR` must be a persistent volume.
- Health: `GET /health` answers `200 ok` once the app is ready.
- Test everything: `bun run check` (`tsc --noEmit`, then `bun test`). CI runs exactly this.
- The bet's command: `bun run stats`. Moderation: `bun run hide "<name>"`. Balance: `bun run pacing`. Clean slate before the stream: `bun run reset -- --yes` deletes every run and player (hidden names stay); a running server needs no restart.
- Load test: `bun run load -- --url <base url> [--players 500] [--seconds 60]`. Each simulated player (named `load-0000` up) starts a run, plays 5 to 30 s while polling the top 10 every 4 s, finishes with a score that passes the plausibility check, fetches its best and the top 10 as the game-over screen does, and starts again; runs open at the deadline still finish. It prints requests, statuses and p50/p95/p99 per route, and exits 1 unless 95% of requests took under 200 ms with no 4xx or 5xx and no network error (a 4xx means the test itself is wrong, such as a 429 from a server started without the raised limit). Every simulated player comes from one IP, so the server under test runs with `RUN_STARTS_PER_WINDOW` raised (it defaults to the real 30; anything but a positive whole number stops the server from starting). Never set it in production. The procedure, with a throwaway data folder (never `data/`):
  - `bun run build`
  - Start the server. bash: `RUN_STARTS_PER_WINDOW=100000 DATA_DIR=<scratch folder> bun run start`. PowerShell: `$env:RUN_STARTS_PER_WINDOW='100000'; $env:DATA_DIR='<scratch folder>'; bun run start`.
  - In a second terminal: `bun run load -- --url http://127.0.0.1:3000`.
  - Then `bun run reset -- --yes` with the same `DATA_DIR`, or delete the folder.
  - The script lives in `scripts/load.ts`; its argument parsing, claims and summary math are in `scripts/load-lib.ts`, which `bun run check` tests. The load run itself is not part of `bun run check`. The team totals route and `/board` join the route table in `load-lib.ts` once they exist.
- Frame-rate benchmark: `bun run bench`. It builds the game in bench mode and plays a 60 s stress run (150 bugs, every upgrade at its top level) in headless Chrome at 1440x900 and at 390x844 @3x. It prints avg fps, the worst 1 s and `draw()` time, and checks that the game-over screen fits at phone portrait, phone landscape and desktop. It needs Chrome (`CHROME_PATH` to point at one), so it is not part of `bun run check`.

## Shape
- Browser game -> HTTP API -> one SQLite file.
- `src/web/App.tsx`: name and team entry, the canvas, the game-over screen.
- `src/web/over.ts`: the game-over screen's list of upgrades taken, each with its level.
- `src/web/game/`: the game in plain TypeScript.
  - The simulation (robot, bugs, shots, hits, upgrades, spawn ramp) is pure: it advances by a time step from input and state, with no canvas, DOM or clock access, so `bun test` covers it.
  - Upgrades: every 20 s of run time the simulation stops advancing and offers up to 3 different upgrades not yet at their top level (level 2); `choose` takes one and play resumes, so the pause never counts as time survived. The cards are drawn from their own generator, seeded from the run's seed, so a run's choices are deterministic and taking one never changes the swarm.
  - The refactor bomb goes off on its own: once charged, on the first step that starts with a bug in the arena (so never a bug in the step it spawned), it clears every bug (each one counts as a squash) and recharges. The simulation keeps only the run time of its last blast (`bombAt`); its ring and charge indicator are drawn from that (`bombRing`, `bombCharge`).
  - The loop (`loop.ts`) runs on `requestAnimationFrame` with a fixed time step and draws the state to the canvas, scaled to the screen in portrait or landscape. The arena has the same area (360,000 units²) on every screen and the screen's ratio, clamped between 9:16 and 16:9, fixed when the run starts.
  - Drawing: `render.ts` draws a frame from the state and the effects; `sprites.ts` pre-renders the floor, glows, bug and robot sprites on offscreen canvases (rebuilt only when the resolution changes); `look.ts` holds every colour and size, with one entry per bug kind in `BUG_KINDS`.
  - Effects (`fx/`): pure, pooled in typed arrays, tested without a canvas. `changes.ts` finds squashes, hits and test-shield blocks by comparing the bug list between frames (and the hit and block counters), so the simulation needs no event hooks; effects use their own seeded generator, never the simulation's.
  - `config.ts` holds every tuning number (spawn ramp, robot, shots, upgrade strength) and `BUG_KINDS`, the one list of bug kinds the simulation imports; `look.ts` gives each kind its look. The upgrade ids are `UPGRADE_IDS` in `src/server/rules.ts`, so the server checks against the same list; `config.ts` gives each its card text.
  - Input: touch drag (the robot moves toward the finger), WASD and arrow keys, mouse steering, 1-3 or tap to pick an upgrade, F for the frame-rate readout on desktop (fps, bugs on screen, effects alive; `fps.ts` is the meter).
  - Stress mode (`?stress=150`, or a bare `?stress`): `createState`'s `stress` option holds the swarm at that many bugs after every step, with every upgrade at its top level and a robot that can't lose, and ends the run at 60 s. It steers itself in a circle until the player steers, and records each frame for the bench. The flag is read only in the dev server and the bench build (`src/web/stress.ts`); a production build ignores it. A stress run is never submitted in any build: no run start, no score, no best.
  - The API client starts a run and submits its score without blocking the loop; failures are logged and the game-over screen says the score wasn't saved.
- `src/web/board/`: the `/board` page for the stream (top 10 and team totals, big type, polls the API).
- `src/server/app.ts`: `/health`, and routes under `/api`: start a run (returns a run id), finish a run (score, squashes, upgrades, device type), top 10, a player's best, team totals.
- `src/server/db.ts`: the SQLite file, its tables, `EVENT_TYPES` (`run_started`, `run_ended`) and `TEAMS` (`tabs`, `spaces`). Schema changes are additive.
- `src/server/rules.ts`: name rules, score plausibility (max points per second of real elapsed time) and `UPGRADE_IDS`, all pure and tested.
- `src/server/blocked-words.ts`: the blocked-word list.
- `src/server/main.ts`: production entry; reads `PORT`, `DATA_DIR` (default `data/`) and, for load testing only, `RUN_STARTS_PER_WINDOW` (`src/server/limits.ts`).
- `scripts/stats.ts`, `scripts/hide.ts`, `scripts/reset.ts`, `scripts/pacing.ts`, `scripts/bench.ts`, `scripts/load.ts` (with `scripts/load-lib.ts`, its tested pure half).
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
- Public on the internet during the stream: the API accepts only well-formed requests with capped sizes, at most one score per run id, scores that pass the plausibility check, and at most 30 run starts per IP per 10 minutes (`RUN_STARTS_PER_WINDOW` raises this for `bun run load` only; never set in production).
- Nothing the player does depends on a server response; a run plays with the API down.

## Decisions deferred
- Spawn rates, bug speed and upgrade strength: tuned in `src/web/game/config.ts` to the PRD's targets: an idle player loses within 30 to 60 s, and a player who keeps moving survives 1 to 3 minutes, because the gun reloads faster while the robot moves (and the CI drone slower while it stands still). From 60 s the swarm surges: the spawn interval falls again to its last floor and every bug speeds up with run time (`swarmSpeed`), so no upgrade build holds forever. `sim.test.ts` holds both targets with scripted players and upgrade choices off, so they guard the swarm alone. Run length with upgrades is measured by `bun run pacing` (`src/web/game/pacing.ts`): an idle player and a realistic mover (sees bugs within 200 units, reacts 0.25 s late, drifts to the centre, wobbles) through each upgrade order, over seeds 0-49 and both screen shapes; `pacing.test.ts` asserts its targets on 8 seeds. How it feels to a human is still the Phase 2 playtest.
- Art: drawn in code on the canvas (see `direction.md`, "The look"). Effects live in `src/web/game/fx/` (particles, trails, screen shake, floating text, the shield's pop), pooled so they allocate nothing per frame.
