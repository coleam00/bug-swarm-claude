# Direction

Bug Swarm is a 2-minute browser survival game for a livestream audience: steer a robot through a growing swarm of bugs, pick an upgrade every 20 seconds, and land on a shared top 10 and a Tabs vs Spaces team race the stream shows live.

## It is
- A browser game that opens from a link in seconds, with a name and no account.
- Played with one thumb on a phone, or keys or the mouse on a computer.
- Runs of 1 to 3 minutes, one tap from the next run.
- One loop at the center: steer, the robot fires by itself, survive the swarm, choose upgrades.
- A shared leaderboard, a team race, and a big-type board page for the stream.
- A small record of every run, so the owner can judge the bet with `bun run stats`.

## It is not
- Real-time multiplayer: players share a board, not an arena.
- An account system or saved progress between runs.
- Monetized: no purchases, no ads.
- Audio, this release.
- Connected to YouTube chat or any other outside service.

## The look
A step above simple shapes, drawn entirely in code on the canvas (no image files, no art pipeline):
- **Arena:** a dark floor with a faint glowing grid and a soft vignette at the edges.
- **Robot:** a small rounded body with a glowing core and a short light trail when it moves; flashes white when hit.
- **Bugs:** beetle-like bodies with animated legs that turn to face the robot; each kind has its own color and size (the fast bug is small, bright and twitchy).
- **Shots:** bright streaks with a glow; the review laser is a longer beam.
- **Feedback:** a squash pops into a burst of particles with a floating "+10"; a hit shakes the screen briefly; the refactor bomb is an expanding ring; the test shield is a visible bubble; the CI drone orbits with its own small glow.
- **Text:** big, bold, readable on a phone and on a stream shown small.
The look never costs frames: if an effect drops below 58 fps with 150 bugs, it gets simpler.

## Principles
- Time to the next run beats everything: no menus or confirmations between game over and the next run.
- One thumb must be enough. A feature that needs a second control doesn't ship.
- The game never waits on the server. Saving a score is best effort; play is not.
- Anything a viewer types that appears on screen passes the name rules first. The stream is public.
- 60 frames per second with a full swarm beats visual detail.
- Every new bug, upgrade or effect should be small enough to ship in one pull request, because chat will ask for them live.

## Current release
See `PRD.md`.
