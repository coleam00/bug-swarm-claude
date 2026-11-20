# Engineering

- **One command checks everything:** `bun run check` runs type checks and every test. Every change keeps it green.
- **Tests:** every behavior change comes with a test that fails without it. Tests are `*.test.ts` beside the code. Game rules (steering, auto-fire targeting, hits, spawn ramp, upgrade effects, scoring) are tested on the pure simulation by stepping it with fixed inputs, never through the canvas or real time. Name rules and score plausibility are tested in `src/server/rules.test.ts`.
- **Deterministic game logic:** the simulation never reads `Date.now`, `Math.random` or the DOM. Time comes in as a step, randomness from a seeded generator.
- **Frame budget:** no allocation-heavy work or network waits inside the frame loop. A change that adds per-frame work states its cost with 150 bugs on screen (F readout) in the pull request.
- **Phones first:** every screen works on a 390 px wide portrait phone and in landscape; touch targets are at least 44 px; no hover-only controls.
- **Runs everywhere:** commands and scripts work on Windows, macOS and Linux, and CI runs the checks on Linux and Windows. No bash-only scripts in the app, no hard-coded paths or path separators. Tests close every file and database handle before deleting their temporary folders (Windows refuses to delete an open file).
- **Dependencies:** add one only when it removes real work. Say why in the pull request. No game engine.
- **Data:** never commit `data/`. Schema changes are additive.
- **Anything viewers type is untrusted:** names pass `rules.ts` before they are stored or shown, and are rendered as text, never as HTML.
- **Failures are never silent, and never stop play:** a failed score save is logged with the run id and the game carries on. Once a run event is saved, the request succeeds even if a follow-up write fails; log that failure instead, so a retry never duplicates a run.
- **UI state follows the server:** the top 10, best score and team totals render what the server returned, never a copy taken before the request.
- **Names live in one list:** `EVENT_TYPES`, `TEAMS` and the upgrade ids are constants code imports rather than typing the strings.
- **Secrets:** none this release. If one is ever added, read it from the environment and list it in `.env.example` with a fake value.
- **Small changes:** one outcome per pull request. A new bug type or upgrade is its own pull request.
