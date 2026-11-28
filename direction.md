# Direction

Bug Swarm is a real-time multiplayer arena for a livestream audience: everyone who opens the link drops into a shared arena with other viewers, aims and shoots through waves of bugs, dodges, revives teammates, and climbs a shared top 10 and a Tabs vs Spaces team race the stream shows live.

This is release 2. Release 1 (a single-player survival game where the robot fired on its own and play paused for upgrades) is kept on the `release-1` branch and its PRD in `docs/prd-release-1.md`, for history only. Where release 1 code, docs or tests contradict this file, this file wins.

## It is
- A browser game that opens from a link in seconds, with a name, a team and no account.
- **Multiplayer for real:** you see the other players in your arena move, aim, shoot, go down and get revived, live. A busy stream fills several arenas; each holds up to 20 players. A quiet arena is topped up with a few clearly marked bots so nobody plays alone.
- **A skill game:** you aim every shot, and shots travel, so you lead moving targets. Holding the trigger overheats the gun, so bursts beat spraying. A short dash with a cooldown gets you out of trouble if you time it. Every bug kind shows a readable tell before it does something dangerous, and each needs a different answer: dodge, sidestep, flank, or focus fire with others. A good player scores many times what a player who only runs around scores.
- **Co-op inside, competition outside:** everyone in an arena fights the same swarm. A downed player is revived by anyone standing next to them, from either team. Every point counts for your team, Tabs or Spaces.
- **Power-ups worth fighting for:** bugs drop the four developer tools from release 1, now as short pickups you have to go and grab: review laser, test shield, refactor bomb, CI drone.
- Controls: on a computer, WASD or arrows move, the mouse aims, holding the left button fires, Space or Shift dashes, Q or E throws a grenade. On a phone, twin sticks: the left thumb moves, the right thumb aims and fires while held, a dash button sits above the right stick and a GRENADE button sits left of the dash button. Landscape is the best phone layout; portrait still works.
- Short lives, instant respawn: a life usually lasts 1 to 4 minutes, and one tap or key drops you back in.
- A big-type board page for the stream: the top 10, the team race and how many people are playing right now.

## It is not
- Single-player. No mode where you play alone against a local simulation.
- Auto-aim or auto-fire. Nothing shoots for you (a CI drone pickup is a short, visible exception you earned).
- Player-versus-player damage, except the grenade's blast.
- An account system or saved progress between lives.
- Monetized: no purchases, no ads.
- Audio, this release.
- Connected to YouTube chat or any other outside service.

## The look
Release 1's look carries over and grows: everything is drawn in code on the canvas (no image files, no art pipeline), and it should feel like a polished arcade game.
- **Arena:** a large dark floor with a faint glowing grid, soft vignette, and glowing walls at the world's edge. The camera follows you smoothly; a small minimap shows teammates, the swarm and the boss.
- **Players:** release 1's robot (rounded body, glowing core, light trail) in its team colour (Tabs orange, Spaces teal), with a name tag and a barrel that points where it aims. Your own robot always has the bright ring and halo, so you find yourself in a crowd. A dash leaves an afterimage streak.
- **Bugs:** release 1's beetle bodies with animated legs, one colour and size per kind, each with a tell you can read from across the screen (a dasher crouches and glows before it lunges; a spitter swells before it spits).
- **Shots:** bright streaks with a glow; hits spark, kills burst into particles with a floating score. Heat is a small arc around your robot that fills as you fire and flashes before it locks.
- **Text:** big, bold, readable on a phone and on a stream shown small. Screens are clean: no rule lists, no fine print.
- **The start screen sells the game:** the live arena plays behind it (real bots fighting the swarm), with the title, a name field and two team buttons on top.
The look never costs frames: 60 fps with a full arena (20 players, 150 bugs and their shots) on a mid-range laptop and phone. If an effect costs frames, it gets simpler.

## Principles
- **Skill decides the score.** Every mechanic is judged by whether it makes aiming, moving and timing matter more. A change that lets you score without aiming doesn't ship.
- **Other players matter.** Seeing, helping and racing other people is the point; every screen shows you are not alone.
- **The server is the referee.** The arena runs on the server; clients send inputs and draw what the server says. Scores come from the server, never from a client.
- **Fair drop-in:** a viewer who joins an hour into the stream gets the same gentle opening as one who joined at the start.
- **Merges happen live.** The game redeploys on every merge during the stream: clients reconnect on their own, reload to the new version, and a life in progress is saved, never lost silently (a 0-point life under 5 s is not a life: #114).
- **Time to the next life beats everything:** no menus or confirmations between a life ending and dropping back in.
- **Clean screens:** the start screen is the title, a name field and two team buttons. Rules appear only as a short message when something is wrong.
- Anything a viewer types that appears on screen passes the name rules first. The stream is public.
- Every new bug, pickup or effect is small enough to ship in one pull request, because chat will ask for them live.

## Current release
See `PRD.md`.
