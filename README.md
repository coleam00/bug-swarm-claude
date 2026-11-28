# Bug Swarm

A real-time multiplayer arena shooter for a livestream audience. Drop into a shared arena with other viewers, aim and shoot through waves of bugs, dash out of trouble, revive teammates, and climb the top 10 and the Tabs vs Spaces team race.

**Play:** https://bug-swarm-claude-production.up.railway.app (stream board at [`/board`](https://bug-swarm-claude-production.up.railway.app/board))

## How it was built

No person wrote this game's code. An AI software factory built it: [the Archon software factory pack](https://github.com/dynamous-community/archon-software-factory) (Rasmus's work) running on [Archon](https://github.com/coleam00/Archon), with Claude in every seat, working from a PRD. Claude orchestrated it: it filed the work items, answered the factory's questions as owner, checked every pull request in real browsers, and merged them.

- **Release 1** (single-player, auto-fire): the `release-1` branch, 24 pull requests.
- **Release 2** (this multiplayer arena): `main`, tracker issue #50.

## Run it

```bash
bun install
bun run dev        # game and API with hot reload
bun run check      # type checks and every test
bun run build && bun run start   # production mode on PORT (default 3000)
```

More commands:
- `bun run bots -- --url <base> --count <n> --seconds <s>`: WebSocket bots (against a scratch server started with `BUG_SWARM_ALLOW_LOAD=1`).
- `bun run skill`: the skill gates.
- `bun run playtest -- --serve --scenario <basic|revive|late-join|restart|queen>`: several real browser players at once.

The docs for agents and people working on the game:
- `AGENTS.md`;
- `direction.md` (what it is);
- `PRD.md` (what we're building);
- `architecture.md` (how it works);
- `engineering.md` (how changes are made).
