# Bug Swarm Arena: a multiplayer skill shooter a whole livestream plays together

> **Release:** 2 (Arena) · **Kind:** real-time multiplayer browser game · **Owner:** coleam00 · Release 1: branch `release-1`, PRD `docs/prd-release-1.md`

## Problem

Release 1 played well alone, but the robot fired by itself, so there was little skill to master, and other viewers were only names on a board. On Sat 11/28 (9:00 AM CT) several hundred livestream viewers need something they want to play together for an hour or more, on phones and laptops, while the owner's AI software factory ships chat's ideas into it live.

## The bet

- **Hypothesis:** If viewers drop into shared arenas where they aim, dodge, revive each other and race for their team, at least 150 viewers will play during the stream and the median player will play at least 3 lives, because skill, other people and the team race make "one more life" compelling.
- **Command:** `bun run stats -- --since <ISO> --until <ISO>` prints the same four lines as release 1, where a **run is one life** in the arena (spawn to out; a life that ended with 0 points within its first 5 s, a refresh or a dropped connection, is not one, owner ruling #114): `players`, `finished_runs`, `median_runs_per_player`, `touch_share` (share of lives played with touch controls). Bot lives never count.
- **Threshold:** `players` ≥ 150 and `median_runs_per_player` ≥ 3.0 during the stream window (Sat 11/28 9:00 to 11:00 AM CT).
- **Skill is measured:** `bun run skill` plays seeded arenas with scripted policies and must show an aiming player out-scoring a player who only moves and fires straight ahead by at least 2x (median), aiming late joiners living at least 0.8x as long as early joiners (the mover's ratio is reported, not gated), and an idle newcomer surviving at least 10 s.

## Outcome

- Opening the link shows the live arena behind a clean start screen: the title, a name field and two team buttons. A returning player sees one "Play as <name>" button and a small "change name" link that reopens the name field.
- Joining drops you into the fullest arena that has room (up to 20 players), at a safe spot with 2 s of spawn protection. You see the others, their names and team colours, live. Arenas with fewer than 4 people are topped up with bots (marked "bot", never on the board), which leave as people arrive.
- You move and aim separately and fire by holding. Shots travel; the gun overheats if held. A dash (1.5 s cooldown) moves you a short distance fast and makes you untouchable for a moment.
- Swarm pressure is personal: it starts low with each life and rises with that life's age, so late joiners get an opening. Bugs chase the nearest player, so groups share pressure. The arena's wave clock (every 30 s) unlocks bug kinds and events, never raw spawn volume.
- Bug kinds, each with a tell and a counter: **crawler** (chases), **dasher** (crouches and glows, then lunges in a line: sidestep or dash), **spitter** (keeps its distance, swells, lobs slow globs you can dodge or shoot), **beetle** (a front shell blocks shots: flank it). Every fifth wave a **hive queen** arrives that only a group takes down quickly.
- 3 hits put you **down**. Anyone standing next to you for 2 s revives you with 1 hit left. If nobody does within 10 s, the life ends, its score is saved, and one tap drops you back in.
- Scoring: kills score by kind; consecutive hits build a streak multiplier (x1 to x3) that a miss resets; a shot a beetle's shell blocks neither builds nor resets it; a revive scores 50. Every point counts for your team.
- Pickups drop from kills and last a short time: review laser (shots pierce), test shield (blocks one hit), refactor bomb (clears bugs around you), CI drone (an orbiting helper that fires on its own for 12 s), invisibility cloak (bugs stop targeting you for 10 s, though contact still hurts). Your first life of a session starts with a test shield up.
- The life-over screen shows the score, best, rank and team totals, and one tap or key starts the next life.
- `/board` shows the top 10 lives, the Tabs vs Spaces totals and how many people are playing now, readable on a stream.
- Merges during the stream redeploy the game; players reconnect on their own and no life's score is lost to a deploy.

## Invariants

- Opening the link to playing: under 10 seconds on a first visit, under 2 on a return visit.
- The server simulation is authoritative. Clients send only inputs (move vector, aim angle, fire held, dash pressed). Scores, hits and kills are decided by the server.
- Each arena holds at most 20 players (people and bots). One server process handles at least 200 connected players across arenas with a server tick under 10 ms at p95, measured by `bun run bots`.
- Clients render at 60 fps with a full arena on a mid-range laptop and phone (desktop Chrome with device emulation counts).
- 20 Hz server ticks; clients predict their own movement and interpolate everything else about 100 ms behind, so controls feel immediate on a 100 ms connection.
- Redeploy-safe: on shutdown every life in progress is ended and saved (except a 0-point life under 5 s, which is not a life); clients reconnect with backoff and reload when the server's build id changes.
- Every name shown passes the name rules, and `bun run hide "<name>"` removes it from every board and every live arena within 5 seconds.
- No account, no purchases, no ads, no audio.

## Acceptance (the whole release)

- [ ] Two browsers and bots share one arena; each browser sees the others move, shoot, get hit, go down and be revived, in real time.
- [ ] Desktop: WASD/arrows move, the mouse aims, holding the left button fires, Space or Shift dashes. Phone (two-point touch emulation counts): left thumb moves, right thumb aims and fires, a dash button.
- [ ] Shots travel and can miss; holding fire overheats; `bun run skill` passes its three gates.
- [ ] Four bug kinds with distinct behaviours and visible tells, and a hive queen every fifth wave that needs several players.
- [ ] Downed players can be revived by anyone; lives end after 10 s down; one tap respawns.
- [ ] Scores are server-side; the top 10, best, team totals, `/board` and `bun run stats` count human arena lives only.
- [ ] `bun run bots -- --url <base> --count 200 --seconds 120` runs 200 WebSocket bots across arenas with 0 errors and a tick p95 under 10 ms.
- [ ] Killing the server mid-arena saves every life in progress (a 0-point life under 5 s is not a life, #114); on restart clients reconnect without a manual reload, and a new build id reloads them.
- [ ] A multi-player playtest drives several real browser players at once (move, aim, fire, revive) and checks that their screens agree.

## How the work is filed

No phase gates: the owner (the orchestrator) files small items in dependency order, each one pull request, each leaving `main` playable. The arena is built at `/arena` first, then becomes the game at `/`; release 1 gameplay is retired at that switch.

## Non-goals

- Accounts, sign-in, saved progress, purchases, ads, audio.
- Friendly fire.
- Reading YouTube chat or any outside service.
- A matchmaking service, regions, or more than one server process.

## Decided by the owner (11/21/2026)

- Release 1's auto-fire, drag-only steering and the upgrade pause are retired. The four upgrades return as pickups.
- A run is one life. Teams stay Tabs vs Spaces. Names, moderation, `hide`, `stats`, `reset`, Railway hosting and the Dockerfile stay.
- Scores are computed by the server, so release 1's plausibility caps and the score review hold do not apply to arena lives.
- Bots are allowed in arenas and in tests, always named with a `bot ` prefix the name rules reserve for the server, and never on any board or in `stats`.
- Evidence of frame rate, touch and layout: Chrome on the factory's machine, headless or with device emulation, counts. Never ask for a physical device.
