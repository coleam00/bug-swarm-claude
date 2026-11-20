# Bug Swarm: a 2-minute survival game a whole livestream can play at once

> **Release:** first release · **Kind:** browser game · **Owner:** coleam00

## Problem

A livestream audience can only watch. When a stream shows off software, chat sees it on someone else's screen, so they type a few comments and drift off, and nothing they do changes what happens. The usual fixes (polls, "drop a 1 in chat") are a minute of attention at most. On Sat 11/28 the owner wants several hundred viewers doing something together for the whole hour: playing a game the owner's AI software factory built, on their own phone or laptop, and watching it change while they play as the factory ships what chat asks for.

## Evidence

- The owner's own streams: chat activity spikes when viewers are asked to do something and fades during long explanations.
- Assumption: viewers will open a link from a stream and play on the device they're watching on, mostly phones. Validate with the share of runs from touch devices during the stream.
- Assumption: a run of about 2 minutes with an instant restart and a shared leaderboard makes most players play several runs. Validate with runs per player during the stream.

## Why build it, and why now

It opens from a link with nothing to install and no account, works with one thumb, and every run ends on a shared top 10 and a team race (Tabs vs Spaces) that the stream shows live, so even a weak player is helping their team. The upgrade choice every 20 seconds makes each run play differently. Now, because the owner is running a Black Friday livestream on Sat 11/28, 9:00 AM CT, where the game is the main event and the factory ships chat's requests into it live.

## Users and the job

- **Primary user:** a viewer of the owner's YouTube livestream, on a phone or a laptop, who has the stream open and a minute or two at a time.
- **Job:** When I'm watching the stream, I want to jump into the game in seconds and get on the board, so I'm part of what's happening instead of only watching it.
- **Also:** the owner, who shows the board on stream and reads the bet's numbers afterward.
- **Not for:** long sessions, players who want accounts or saved progress, competitive players who need cheat-proof rankings.

## The bet

- **Hypothesis:** If we ship Bug Swarm's first release, at least 150 viewers will finish a run during the livestream, and the median player will play at least 3 runs, because a 2-minute run with an instant restart, a shared top 10 and a team race keeps people coming back for one more.
- **Signal:** distinct players with at least one finished run, and the median number of finished runs per player, within the stream window.
- **Command:** `bun run stats -- --since <ISO time> --until <ISO time>` prints exactly four lines (without the flags it counts everything):
  ```
  players: <distinct players with at least one finished run>
  finished_runs: <runs that ended in a game over>
  median_runs_per_player: <median finished runs per player, one decimal, 0.0 when none>
  touch_share: <percent of finished runs played on a touch device, whole number>%
  ```
  On an empty database it prints the same four lines with zeros. Phase 1 builds this command.
- **Threshold:** `players` is at least 150 and `median_runs_per_player` is at least 3.0.
- **Window:** the livestream, Sat 11/28/2026 from 9:00 to 10:15 AM CT.
- **Wrong if:** fewer than 50 players finish a run (viewers don't open the link), or the median player plays only 1 run (it isn't fun enough to replay).

## Outcome

- Opening the link asks for a name once (and, from Phase 3, a team), then starts a run.
- The player steers a small robot around an arena while bugs swarm in from the edges; the robot fires at the nearest bug by itself.
- Every 20 seconds the game pauses and the player picks 1 of 3 upgrades, so each run builds differently.
- The swarm grows until it overwhelms the player, usually in 1 to 3 minutes. The game-over screen shows the score, the live top 10 and the player's best, and one tap starts the next run.
- A big-type board page shows the top 10 and the Tabs vs Spaces race for the stream.
- It looks like a real game, not a prototype: a glowing robot, animated bugs, bursts when bugs pop, a little screen shake on hits, all drawn in code with no image files.

## Invariants

- From opening the link to playing takes under 10 seconds on a first visit (name entry included) and under 2 seconds on a return visit.
- Fully playable with one thumb on a phone (drag to steer) and with WASD, arrow keys or the mouse on a computer. Portrait and landscape both work.
- 60 frames per second with 150 bugs on screen in current Chrome on a mid-range phone and laptop.
- The game never waits on the server: if the API is down, the run still plays, and the game-over screen says the score couldn't be saved.
- Every name shown anywhere passes the name rules (2 to 16 characters, letters, numbers, spaces, `-` and `_`, not on the blocked-word list), and the owner can hide any name from every board with one command.
- The server accepts a score only for a run it started, and only if the score is possible for the time the run actually lasted by the server's clock.
- Every visual effect fits the frame budget: the look never costs the 60 frames per second.
- No account, no sign-in, no purchases, no ads, no audio this release.

## Acceptance

- [ ] First visit: enter a name, play within 10 seconds; return visit: play within 2 seconds; one tap or key restarts after game over.
- [ ] Drag steering works on a phone in portrait and landscape; WASD, arrows and mouse steering work on a computer.
- [ ] The robot fires at the nearest bug on its own; a bug that touches the robot costs one of 3 hits; the third hit ends the run.
- [ ] Every 20 seconds play pauses for a choice of 3 upgrades out of the pool, and the chosen upgrade visibly works.
- [ ] Score is 10 points per bug squashed plus 1 point per second survived, and the server rejects scores impossible for the run's real length.
- [ ] The game-over screen shows the score, the player's best, and the live top 10; `/board` shows the top 10 and team totals in type readable on a stream, refreshing at least every 5 seconds.
- [ ] Blocked names are refused at entry with a message; `bun run hide "<name>"` removes a name from every board within 5 seconds.
- [ ] `bun run stats` prints the four lines from "The bet", and the numbers match a hand count over a test set of runs.
- [ ] The app runs from its `Dockerfile` with `PORT` and `DATA_DIR`, and keeps scores across a restart.

## Phases

The factory files one phase at a time. Each phase leaves the game playable.

### Phase 1: One arena, one leaderboard

- **Proves:** a viewer can open the link, play a full run on a phone or laptop, and land on a shared top 10, and every run is counted for the bet.
- **Outcome:** name entry, then a run: the robot steers by drag or keys, one kind of bug spawns from the edges at a steady rate and chases the robot, the robot auto-fires, 3 hits end the run. The game-over screen shows score, best and the top 10, and one tap starts again. The owner can read the bet's numbers and hide a name.
- **Acceptance:**
  - [ ] The game starts with one command; first visit asks for a name (name rules enforced, blocked names refused with a message), then the run starts; drag steering on touch and WASD/arrows/mouse on desktop both work.
  - [ ] Bugs chase the robot, the robot fires at the nearest bug, a squash scores 10 and each second survived scores 1, and the third hit ends the run.
  - [ ] The server issues a run id when a run starts and accepts one score for it, rejecting a score that's impossible for the real elapsed time; the game-over screen shows the top 10, the player's best, and "couldn't save your score" if the API is down.
  - [ ] `bun run stats` prints the four lines from "The bet" (zeros on an empty database, `--since`/`--until` filter); `bun run hide "<name>"` hides that name from the top 10 within 5 seconds.
  - [ ] A `Dockerfile` runs `bun run start` with `PORT` and `DATA_DIR`; one command runs every test, and CI runs it on every pull request.
- **Before Phase 2 is filed:** Phase 1 is merged, and the owner plays three runs on a phone and one on a laptop, sees all four counted by `bun run stats` and on the top 10, and hides one test name.

### Phase 2: The swarm and the upgrades

- **Proves:** the upgrade choice makes runs different and long enough to want another.
- **Outcome:** the swarm grows over the run (more bugs, faster spawns), a second kind of bug (fast and fragile) joins after 30 seconds, and every 20 seconds play pauses for a choice of 3 upgrades. Typical runs last 1 to 3 minutes.
- **Acceptance:**
  - [ ] Spawn rate and bug count ramp over the run so that an idle player loses within 60 seconds; a test steps the simulation to check it.
  - [ ] The look from `direction.md` ("The look"): the robot glows and leaves a short trail, bugs have animated legs and turn to face the robot, a squashed bug pops in a burst of particles with a floating "+10", a hit flashes the robot and shakes the screen briefly, each upgrade has its own visible effect, and the arena has a dark grid floor with a soft vignette. All drawn on the canvas in code, with no image files.
  - [ ] The fast bug appears after 30 seconds, moves at least 1.5x the base speed, and dies in one shot.
  - [ ] Every 20 seconds play pauses with 3 different upgrades drawn from the pool, chosen by tap or the keys 1-3: **Review laser** (shots pierce through bugs), **Test shield** (blocks the next hit), **Refactor bomb** (clears the screen once, recharges after 30 s), **CI drone** (orbits the robot and fires too). Picking one twice makes it stronger.
  - [ ] The game-over screen lists the upgrades taken; holding 150 bugs on screen stays at 58 frames per second or above (F shows a readout on desktop).
- **Before Phase 3 is filed:** Phase 2 is merged, and the owner plays five runs, takes a different set of upgrades in each, and the median run lasts between 60 and 180 seconds.

### Phase 3: Tabs vs Spaces, and the stream board

- **Proves:** a team race gives every player, not only the top 10, a reason to keep playing.
- **Outcome:** on first visit the player picks Tabs or Spaces next to their name; every finished run adds its score to the team. `/board` is a full-screen page for the stream: the top 10 and the two team totals as a race, in type readable when the stream is shown small.
- **Acceptance:**
  - [ ] First visit asks for a team (Tabs or Spaces) with the name; existing players are asked once on their next visit; the game-over screen shows both team totals.
  - [ ] `/board` shows the top 10 and both team totals, refreshes at least every 5 seconds, and is readable at 1280x720 shrunk to a quarter of the screen.
  - [ ] A load script (`bun run load`) simulates 500 players starting runs, finishing them and polling the board, and the server answers 95% of requests in under 200 ms on a laptop.
- **Before the livestream:** Phase 3 is merged and deployed, the owner plays on a phone and a laptop against the deployed URL, the board shows both, and the data is checked with `bun run stats`.

## Non-goals

- Accounts, sign-in, or saved progress between runs.
- Real-time multiplayer (players share a board, not an arena).
- Purchases, ads, or prizes handled by the game.
- Audio and music (a later release).
- Reading YouTube chat or any outside service.
- Cheat-proof scoring beyond the plausibility check; the owner hides bad entries by hand.

## Open questions

None. Decided by the owner on 11/18/2026:

- The name is "Bug Swarm".
- Score is 10 per squash plus 1 per second survived, with 3 hits per run.
- Teams are Tabs vs Spaces.
- Players are told apart by a random id kept in the browser, with no account; clearing browser storage makes a new player with a new name.
- The threshold is at least 150 players and a median of 3.0 runs per player over the stream window (9:00 to 10:15 AM CT Sat 11/28).
- Phase 1 is one bug type, no upgrades, no teams, and plain placeholder visuals; Phase 2 adds the swarm, upgrades and the look; Phase 3 adds teams and the board.
- The blocked-word list is a plain list in `src/server/blocked-words.ts` that the owner can extend; matching ignores case and common letter swaps (0 for o, 1 for i, 3 for e, 4 for a, 5 for s).
- Hosting is Railway (see `architecture.md`); the app needs a `Dockerfile`, `PORT`, and a persistent `DATA_DIR`.
- The art is a step above plain shapes: the look in `direction.md`, drawn in code, no image files.
