# Engineering

- **One command checks everything:** `bun run check` runs type checks and every test. Every change keeps it green.
- **Tests:** every behavior change comes with a test that fails without it. Tests are `*.test.ts` beside the code. Game rules (movement, aiming, shots, heat, dash, hits, bug behaviours, revive, scoring, pickups, waves) are tested on the pure arena simulation by stepping it with fixed inputs, never through the canvas, real time or a real socket. Networking (join, rooms, protocol, reconnect) is tested with real WebSocket clients against a server on an ephemeral port that the test closes before it ends. Name rules are tested in `src/server/rules.test.ts`.
- **Layout is measured, not tested (owner ruling, 2026-11-20):** a CSS-only layout change needs no automated layout test; `bun run check` has no browser. The pull request states the viewport sizes it was measured at in a real browser (phone portrait and landscape, and desktop) and what fit. Behaviour drawn on the canvas still follows the test rule through the pure simulation.
- **Skill is measured, not argued (release 2):** a change to combat, bug behaviour, pickups or pacing runs `bun run skill` and states its numbers in the pull request (aimer vs mover median, late vs early joiners, idle newcomer survival). A change that fails a gate is not tuned past it by weakening the gate's policies; the gates in `PRD.md` change only by owner ruling. Release 1's run-length rulings are retired with release 1.
- **Deterministic game logic:** the simulation never reads `Date.now`, `Math.random` or the DOM. Time comes in as a step, randomness from a seeded generator.
- **Frame budget:** no allocation-heavy work or network waits inside the frame loop. A change that adds per-frame work states its cost with a full arena on screen (F readout) in the pull request.
- **Server budget:** the arena tick allocates as little as possible and never waits on the database; lives are saved off the tick. A change that adds per-tick work states the tick p50/p95 from `bun run bots` in the pull request.
- **Multiplayer evidence:** a change players can see in the arena is checked with at least two browser players at once (two tabs, or a tab plus bots), and the pull request says what each one saw.
- **Evidence stays in the checkout:** screenshots, logs and probe scripts made while proving a change go in `.evidence/<issue number>/` (ignored by git), never outside the working copy.
- **Asks:** when a stage asks the owner, every option has a real id; never an option with the id `other`.
- **Phones first:** every screen works on a 390 px wide portrait phone and in landscape; touch targets are at least 44 px; no hover-only controls. Twin-stick touch is validated with two-point touch emulation in Chrome.
- **Runs everywhere:** commands and scripts work on Windows, macOS and Linux, and CI runs the checks on Linux and Windows. No bash-only scripts in the app, no hard-coded paths or path separators. Tests close every file and database handle before deleting their temporary folders (Windows refuses to delete an open file).
- **Dependencies:** add one only when it removes real work. Say why in the pull request. No game engine.
- **Data:** never commit `data/`. Schema changes are additive.
- **Anything viewers type is untrusted:** names pass `rules.ts` before they are stored or shown, and are rendered as text, never as HTML.
- **Failures are never silent, and never stop play:** a failed score save is logged with the run id and the game carries on. Once a run event is saved, the request succeeds even if a follow-up write fails; log that failure instead, so a retry never duplicates a run.
- **UI state follows the server:** the top 10, best score and team totals render what the server returned, never a copy taken before the request.
- **Names live in one list:** `EVENT_TYPES`, `TEAMS`, bug kind ids, pickup ids and protocol message types are constants code imports rather than typing the strings.
- **Secrets:** `ADMIN_TOKEN` is the one secret. Read it from the environment, list it in `.env.example` with a fake value, and never print or log it.
- **Bun:** 1.4.5 is pinned in the `Dockerfile` and CI. The minimum is 1.4.x: on 1.3.5 `bun run check` hangs with EBUSY temp-dir errors.
- **Small changes:** one outcome per pull request. A new bug kind or pickup is its own pull request.

## Live operations

On Railway there is no shell in the container; the owner runs stats, hide and reset over HTTP (`src/server/admin.ts`).

- Set `ADMIN_TOKEN` on the Railway service (at least 16 random characters), and the same value in your own shell's environment. Without it, or with a shorter one, the admin routes answer 404.
- `bun run admin -- --url https://<service> stats` (add `--since <ISO>` and `--until <ISO>` for the stream window)
- `bun run admin -- --url https://<service> hide "<name>"` (off every board, and out of every live arena, within 5 s)
- `bun run admin -- --url https://<service> reset --yes` (before the stream: every run and player; hidden names stay)
- The token is read from the environment, never an argument, and never printed. Plain `http://` is refused except to localhost. 10 requests a minute per client.
- `DATA_DIR` must point at the service's volume: in production the server refuses to start without it.
