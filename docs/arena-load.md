# Arena load: 200 players on one server (#89)

What one server holds with the full game in play, measured. The budgets are in `architecture.md` "Load": tick p95 under 10 ms with 200 players, and at most 40 KB/s per player.

## How to run it

1. Build and start a production server on a scratch data directory (the bots' lives are saved like anyone's), with the load allowance: every bot connects from this machine's one address, and without `BUG_SWARM_ALLOW_LOAD=1` the server refuses each one past the 12th with `limit` (#104; the run then fails and says so). Never set it on Railway.

   ```sh
   bun run build
   DATA_DIR=/tmp/bugswarm-load PORT=3918 BUG_SWARM_ALLOW_LOAD=1 bun src/server/main.ts
   ```

   On Windows PowerShell: `$env:DATA_DIR = "C:\temp\bugswarm-load"; $env:PORT = "3918"; $env:BUG_SWARM_ALLOW_LOAD = "1"; bun src/server/main.ts`.
2. In another shell:

   ```sh
   bun run bots -- --url http://127.0.0.1:3918 --count 200 --seconds 120 --policy aimer
   ```

   Add `--watchers 2` to also measure what a start-screen watcher receives.

The script prints the arenas, errors, the server's tick p50/p95 and memory (from `GET /api/arena/stats`), per-player KB/s, a `budget:` line per gate and a verdict. It exits 1 on any miss:
- an error (an error message, a failed connect, an unexpected close, or a snapshot a bot could not decode after its first keyframe: `desync`);
- fewer joins than `--count`;
- the stats endpoint unreachable;
- tick p95 not under 10 ms;
- any one bot over 40 KB/s.

**How the bandwidth gate reads.** Each bot counts the payload bytes of every message it receives after its welcome (1 KB = 1000 B). WebSocket framing is not counted: 2 to 4 bytes a frame, about 80 B/s at 20 snapshots a second. A bot's rate is taken over the **second half** of the run. The first half under-reads, because each arena's bugs are still ramping up toward the 150 cap. In the final run below, the first half averaged 11.5 KB/s per bot against 23.3 in the second; the script prints the first half too, ungated. The gate is on the **maximum** over all bots, not the mean.

## The machine

- AMD Ryzen 9 7950X3D (16 cores), 127 GB RAM, Windows 11 Home (the factory's machine).
- Bun 1.4.5. The server and the bots ran on the same machine, over loopback.
- Headless Chrome 157.0.8103.51 for the two-tab check.

## Results

Each run was 200 aimer bots for 120 s against `bun src/server/main.ts` (built `dist/`, scratch `DATA_DIR`). The bots filled 10 arenas of 20.

| | before (#87, protocol v9) | after (#89, protocol v11) |
|---|---|---|
| errors | 0 | 0 (all five runs) |
| arenas | 10 x 20 players | 10 x 20 players (11 in the two-tab run) |
| tick p50 / p95 | 0.99 / 1.83 ms | 1.03 / 2.34 ms (run 1); 0.91 / 1.92 ms (run 2); 1.27 / 2.60 ms (two-tab run, Chrome on the same machine); 0.93 / 2.13 ms (final); 0.92 / 1.83 ms (after merging #84 and #90) |
| per player, KB/s | about 70.6 (every socket got the same snapshot; the watcher's figure) | mean 23.3, p95 26.3, **max 26.5** (run 1); mean 24.3, p95 26.1, max 26.5 (run 2); mean 24.2, p95 26.8, max 26.9 (two-tab run); mean 23.3, p95 26.5, max 26.6 (final); mean 26.5, p95 27.9, **max 28.0** (after merging #84 and #90) |
| watcher, KB/s | 70.6 | 19.9; 21.1 after merging #84 and #90 |
| server memory | 74 MB working set at the end | rss 95.2 MB, heap 9.9 MB (run 1); rss 91.9 MB, heap 8.5 MB (run 2); rss 109.8 MB, heap 16.4 MB (two-tab run); rss 105.3 MB, heap 16.3 MB (final); rss 92.3 MB, heap 8.1 MB (after merging #84 and #90) |
| verdict | (no gate then) | pass, exit 0 |

The "before" numbers come from the same command on `main` at 279249a. Its watcher's 70.6 KB/s is averaged over the whole run, so the first half's ramp pulls it down. #80's tab read 85 KB/s in a crowded arena.

Run 2 and the post-merge run added `--watchers 2`. The post-merge run is on main's CI drone (#84) and #90's pickups (drops x2.5, up to 16 on the floor, a first-life shield): the extra floor rows and effect bits cost about 1.5 KB/s per player. Runs 1, 2 and the two-tab run were back to back on one server process; the final run, on the committed code, had a fresh one. Server memory is `process.memoryUsage()` read by the stats endpoint at the end of each run.

**Where the bytes go.** `.evidence/89/probe-v10.ts` ran one aimer player plus 199 bots and measured seconds 45 to 90 of the run:
- 25.1 KB/s in total, with 101.8 bugs and 20 players in view on average;
- 835 deltas averaging 1170 B. Per delta: bug position deltas `b` 541 B, players `p` 202, shots fired `s` 135, shot ends `e` 67, `me` 64, kills `k` 54, new bugs `nb` 41, the rest under 20 each;
- 44 keyframes averaging 2877 B. Per keyframe: bug rows 1750 B, players 450, `me` 149, minimap far bugs `m` 100.

The aimer bots cluster, so each one sees all 20 robots and most of its arena's bugs. That makes this close to the worst case for culling: it is integer position deltas that get under budget, not culling. `src/shared/arena/view.test.ts` holds a delta under 2000 B with 150 bugs of every kind and 20 players all in view, and a keyframe under 4500 B.

## Two players in browsers while the 200 bots run

`.evidence/89/twotabs.ts` drove the check. It used headless Chrome over CDP, with two windows in separate browser contexts, so each had its own player id. Both joined at `/` *before* the bots, then the 200 bots ran for 120 s; the two tabs and 18 bots shared one arena. Each tab had the F readout on, held a move (D, then A, alternating every 10 s) and the left mouse button (fire). A watcher socket in the same arena decoded the snapshots and logged each tab robot's position every second. A tab whose life ended was tapped to respawn.

The F readout, from the screenshots (`.evidence/89/twotabs-*.png`):

| | TabOne | TabTwo |
|---|---|---|
| t+30 s | 60 fps, 7.6 KB/s, ack 56 ms | 60 fps, 7.9 KB/s, ack 72 ms |
| t+60 s | 60 fps, 6.4 KB/s, ack 87 ms | 60 fps, 13.6 KB/s, ack 70 ms |
| t+110 s | 60 fps, 7.3 KB/s, ack 85 ms | 60 fps, 6.8 KB/s, ack 102 ms |

- **Controls stayed responsive.** Whenever a tab was up with a key pressed, its robot moved at full speed (300 units/s) in the held direction, and it reversed within the second the key changed. For example, TabOne went from x 2386 to 388 holding A, at t+30 to t+37 s. TabTwo went from x 1004.9 to 2386 holding D, at t+22 to t+27 s. (`.evidence/89/twotabs.log`.)
- **When a robot stood still,** it was at a wall, down, or just respawned with nothing held. The life-over screen releases every held key and button (`controls.ts` `releaseAll`, as designed), and the driver re-pressed only the move key, at its next 10 s switch, and never the mouse. So after a tab's first respawn it fired no more, and it stood until the next switch (TabOne from its respawn at t+96 to t+100). The tabs only held a key and fired at the wall, so bugs downed them often.
- **The ack figure** is the p95 time from an input leaving to a snapshot acknowledging it. It includes the server's input queue: one input is applied per tick, and up to 4 are queued. Your own robot is predicted, so moving never waits on it.
- **Bandwidth was lower for the tabs** than for the bots. Holding one direction carried them to the walls, away from the bots' cluster.
- **This is headless Chrome,** whose rAF is not a physical display. It ran with `--disable-backgrounding-occluded-windows`, so neither window was throttled as hidden.
