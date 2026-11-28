// The arena's tuning numbers (release 2). Shared by the server (authoritative) and the browser
// (prediction of your own robot), so both step with the same numbers. Each bug kind's own numbers
// (radius, speed, hit points, points, phases, spawn mix) live in its file in bugs/ (#65,
// architecture.md "Bug kinds (the recipe)"); the arena-wide ones are here.

/** The fixed simulation step, ms. The server ticks at 1000 / TICK_MS = 20 Hz. */
export const TICK_MS = 50;
/** The fixed simulation step, seconds. */
export const DT = TICK_MS / 1000;

/** The world, in units. Walls at the edges. */
export const WORLD_W = 2400;
export const WORLD_H = 2400;

/** A player's collision radius, units: release 1's ROBOT_RADIUS, so a robot looks the same size. */
export const PLAYER_RADIUS = 14;

/**
 * Movement. Weighty but responsive, at the 50 ms step:
 * - from rest, full speed after 3 steps (0.15 s): 120, 240, 300;
 * - from full speed with no input, stopped after 4 steps (0.2 s), sliding 18 units: 210, 120, 30, 0;
 * - a full reversal takes 0.25 s (5 steps).
 */
/** Top speed, units per second. */
export const MAX_SPEED = 300;
/** Acceleration while a move is held, units per second squared. */
export const ACCEL = 2400;
/** Deceleration while no move is held, units per second squared. */
export const FRICTION = 1800;

// ---- Fair drop-in (#58). Safe spawns, spawn protection, a gentle first life. ----

/** Every spawn (a join or a respawn) lands at least this far from every wall. */
export const SPAWN_MARGIN = 450;
/** The item's floor: a spawn lands at least this far from every bug whenever the arena has such a spot. */
export const SPAWN_BUG_FLOOR = 500;
/** Preferred clearance: among candidates at least this far from every bug, the near-player rule picks. */
export const SPAWN_BUG_CLEAR = 900;
/** When no candidate meets SPAWN_BUG_FLOOR, a grid of spots this far apart is searched (no random draws). */
export const SPAWN_GRID_STEP = 50;
/** Spots tried per spawn (always all drawn, so the generator's use is fixed). */
export const SPAWN_CANDIDATES = 16;
/** Among spots clear of bugs, a spawn prefers this distance to the nearest other alive player, units. */
export const SPAWN_NEAR_DIST = 250;
/** Spawn protection, seconds: bugs cannot hurt you; holding fire ends it early. */
export const SPAWN_PROTECT_S = 2;
/** A player's first life in a session counts its pressure this many seconds late (an easier start). */
export const FIRST_LIFE_EASY_S = 10;

/** The most players in one arena. */
export const MAX_PLAYERS_PER_ARENA = 20;
/** An arena with people in it is topped up with server fill bots to this many players (#66). */
export const FILL_TARGET = 4;
/** A people-less arena that someone is watching (the start screen's demo arena, #79) runs this many bots. */
export const DEMO_BOTS = FILL_TARGET;
/**
 * A new demo arena is run this far forward before its first watcher sees it, seconds: a fresh
 * arena's bots meet their first bugs about 40 s in (first-life pacing, spawns out of view), and
 * the start screen should show the fight at once. Nobody ever joins a demo arena, so this skips no
 * one's gentle opening.
 */
export const DEMO_WARM_S = 45;
export const DEMO_WARM_TICKS = Math.round((DEMO_WARM_S * 1000) / TICK_MS);
/**
 * The most sockets watching arenas at once, server-wide; one more is refused with `full` (#79).
 * #119: 300 start screens at once, with room for a few more. Measured: 300 watchers in one arena
 * add about 3.3 ms to its tick (p95 5.7 to 6.3 ms, against 1.94 ms with 40; one send of the shared frame each, about 11 us), so
 * about 400 might approach the 10 ms tick budget (an estimate, not measured).
 */
export const MAX_WATCHERS = 320;
/**
 * The most /ws sockets open at once from one client address (#104, owner ruling): households and
 * phone carriers share addresses, so it leaves room for several people behind one. The 13th is
 * refused with `limit`.
 */
export const MAX_SOCKETS_PER_ADDRESS = 12;
/**
 * The most sockets from one client address watching at once (#119), so no one client can take the
 * server's MAX_WATCHERS. One more is refused with `full`: that start screen shows the drawn
 * backdrop, and Play still joins. Half of MAX_SOCKETS_PER_ADDRESS, so an address at its watcher
 * cap still has sockets for players; it must stay below it, or the socket cap always fires first.
 */
export const MAX_WATCHERS_PER_ADDRESS = 6;
/** The most joins (welcomed hellos) from one client address in any 60 s (#104, owner ruling); one more is refused with `limit`. */
export const JOINS_PER_ADDRESS_PER_MINUTE = 30;
/**
 * The most people playing at once, server-wide (#104, owner ruling), so one viewer can't open
 * arenas without bound. One more is refused with `busy` and opens no arena.
 */
export const MAX_PEOPLE = 600;
/**
 * Owner number (#117): a person out (life over) this long without playing again, or with the tab
 * hidden, stops counting as a person: for arena capacity, fill bots, arena choice and the board.
 */
export const OUT_IDLE_S = 30;
/** OUT_IDLE_S in ticks, counted from the life's end (the player's outTick), never the wall clock. */
export const OUT_IDLE_TICKS = Math.round((OUT_IDLE_S * 1000) / TICK_MS);
/** How often watchers of a people-less arena are moved to the busiest arena with people, ms. */
export const WATCH_SWEEP_MS = 5000;
/** Inputs the server queues per player; one is applied each tick, the oldest dropped past this. */
export const INPUT_BUFFER = 4;
/** Ticks with no new input after which a player's move is zeroed (500 ms). */
export const INPUT_STALE_TICKS = 10;
/** Inputs a socket may send per second; the rest are dropped. */
export const INPUTS_PER_SECOND = 30;
/** The biggest client message the server reads, UTF-8 bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 1024;
/**
 * The protocol version. A hello with another one is refused with error "version". v8: watching
 * (#79) and the bomb (#78); v9 (#80): a shot end's hit 2, blocked by a shell; v10 (#84): a shot's
 * style 2, a CI drone's; v11 (#89): snapshots culled to each player's view, quantized, as keyframes
 * with deltas between (view.ts); v12 (#85): the hive queen's `q` and `queen` event; v13 (#130): the
 * input's `grenade`, the `grenade` event and `me`'s `gc`.
 */
export const PROTOCOL_VERSION = 13;

// ---- Snapshots at stream scale (#89, view.ts). ----

/** Every recipient gets a full snapshot (a keyframe) this often, ticks (1 s), and deltas between. */
export const KEYFRAME_TICKS = 20;
/**
 * A player is sent the bugs, pickups and kills inside a square around where their camera centres,
 * VIEW_MAX / 2 + CULL_MARGIN from that centre on each axis. The margin covers VIEW_PAD, the largest
 * bug's radius, 100 ms of the fastest bug (a dasher's lunge, 48 units) and pop-in at the edge.
 */
export const CULL_MARGIN = 200;
/** The minimap's far bugs (outside that square) come on keyframes, in cells this many units wide. */
export const MINIMAP_CELL = 16;
/** How far behind the server the browser draws other players, ms. */
export const INTERP_DELAY_MS = 100;

// ---- Dash (#60). A press bursts you along your move (your aim if still), untouchable while it lasts. ----

/** How far a dash carries you on open floor, units. */
export const DASH_DISTANCE = 220;
/** How long a dash lasts, seconds: DASH_TICKS steps at DASH_SPEED. Untouchable throughout. */
export const DASH_S = 0.15;
export const DASH_TICKS = Math.round(DASH_S / DT);
/** A dash's speed, units per second (73.3 units a tick). */
export const DASH_SPEED = DASH_DISTANCE / DASH_S;
/** From one dash's press until the next press is accepted, seconds. A press before then is dropped. */
export const DASH_COOLDOWN_S = 1.5;
export const DASH_COOLDOWN_TICKS = Math.round(DASH_COOLDOWN_S / DT);
/**
 * A new life cannot dash for this long, seconds, so the press that respawned you (or a second one
 * sent before your browser sees you alive) never dashes you off the spawn.
 */
export const DASH_SPAWN_LOCK_S = 0.5;
export const DASH_SPAWN_LOCK_TICKS = Math.round(DASH_SPAWN_LOCK_S / DT);

// ---- Grenade (#130). A press throws one along your aim; it lands, blinks, then blasts bugs and players. ----

/** How far a grenade is thrown, units: from the thrower's centre to where it lands (kept inside the walls). */
export const GRENADE_RANGE = 320;
/** How long it flies, seconds, and then how long it blinks on the floor before it goes off. */
export const GRENADE_FLIGHT_S = 0.5;
export const GRENADE_FLIGHT_TICKS = Math.round(GRENADE_FLIGHT_S / DT);
export const GRENADE_BLINK_S = 0.5;
export const GRENADE_BLINK_TICKS = Math.round(GRENADE_BLINK_S / DT);
/** Its blast reaches this far, centre to centre, units. */
export const GRENADE_RADIUS = 110;
/** What the blast does to every bug in reach, hit points (a beetle's shell does not block it). */
export const GRENADE_DAMAGE = 3;
/** From one throw until the next press is accepted, seconds. A press before then is dropped. */
export const GRENADE_COOLDOWN_S = 6;
export const GRENADE_COOLDOWN_TICKS = Math.round(GRENADE_COOLDOWN_S / DT);

// ---- Shooting (#55). Holding fire shoots travelling shots from the barrel along the aim. ----

/** Shots per second while fire is held and the gun is not locked. */
export const FIRE_RATE = 7;
/** Shot speed, units per second (45 units a tick). */
export const SHOT_SPEED = 900;
/** How far a shot flies before it ends as a miss, units. */
export const SHOT_RANGE = 700;
/** Each shot leaves at the aim plus a uniform random angle within +/- this, radians. */
export const SHOT_SPREAD = 0.03;
/** A shot's collision radius, units: it hits a bug within its radius plus this. */
export const SHOT_RADIUS = 3;
/** Shots leave from this far in front of the robot's centre, along the aim (the barrel tip). */
export const BARREL = PLAYER_RADIUS + 6;

// ---- Heat (#55). Each shot adds heat; full heat locks the gun. ----

/** Heat one shot adds (heat runs 0 to 1): a held trigger locks on its 18th shot, about 2.4 s. */
export const HEAT_PER_SHOT = 1 / 18;
/**
 * Heat lost per second while fire is released and the shot cooldown has run out (so tapping fire
 * does not dodge heat). Bursts kept under the lock sustain about 4.6 shots/s, the held trigger's
 * average with its lock, without ever locking.
 */
export const HEAT_COOL_PER_S = 0.75;
/** How long full heat locks the gun, seconds; heat drains to 0 over the lock. */
export const HEAT_LOCK_S = 1.5;
/** Heat from which the HUD arc flashes, warning of the lock. */
export const HEAT_WARN = 0.85;

// ---- Bugs. Every kind's id in BUG_KINDS; each kind's numbers in its own file in bugs/ (#65). ----

/**
 * Every bug kind id, in protocol order (a snapshot carries a bug's index in this list). The first
 * is the base kind: a spawn is the base kind unless the mix picks another (bugs/index.ts).
 */
export const BUG_KINDS = ["crawler", "dasher", "spitter", "glob", "beetle", "queen"] as const;
export type BugKind = (typeof BUG_KINDS)[number];

// ---- Pickups (#73). Every pickup id in PICKUP_IDS; each pickup's numbers in its own file in pickups/. ----

/**
 * Every pickup id, in protocol order (a snapshot carries a pickup's index in this list, and a
 * player's active effects as a bitmask over it).
 */
export const PICKUP_IDS = ["shield", "laser", "bomb", "drone"] as const;
export type PickupId = (typeof PICKUP_IDS)[number];
/**
 * The most pickups lying on the floor of one arena; a drop past it is lost, never queued. #90 raised
 * it from 6: with 12 to 20 aimers the old cap bound, holding a pickup in a player's view about 35% of
 * the time whatever the drop chances; 16 is where that share stopped rising (51% to 58%; measured,
 * architecture.md "Built so far (#90)").
 */
export const MAX_PICKUPS_PER_ARENA = 16;
/** A floor pickup blinks for this long before it goes, seconds (drawn only; the sim ignores it). */
export const PICKUP_BLINK_S = 3;
/** A floor pickup's radius, units: a player who is up takes it within PLAYER_RADIUS plus this. */
export const PICKUP_RADIUS = 12;

// ---- Spawning (#55). Pressure is personal: each player who is up brings their own spawn budget. ----

/** A new life's spawn rate, bugs per second. */
export const SPAWN_BASE_PER_S = 0.3;
/** How fast the rate rises with the life's age, bugs per second per second. */
export const SPAWN_RAMP_PER_S2 = 0.05;
/** The rate's ceiling, bugs per second. */
export const SPAWN_MAX_PER_S = 8;
/** A player's unspent spawn budget is capped here, so a full arena does not bank spawns. */
export const SPAWN_BUDGET_CAP = 2;
/**
 * The most bugs in one arena; past it no bug spawns or is launched (keeps the tick inside its
 * budget). A hive queen (#85) is placed whatever the count, so an arena holds at most one more.
 */
export const MAX_BUGS_PER_ARENA = 150;
/**
 * While a hive queen (#85) is arriving or alive, the spawn mix stops this many short of
 * MAX_BUGS_PER_ARENA, so her brood and her ring of globs have room (bugs/index.ts spawnCap).
 */
export const QUEEN_RESERVE = 16;
/** A bug spawns this far from the player it targets, units. */
export const SPAWN_DIST_MIN = 560;
export const SPAWN_DIST_MAX = 720;
/** Tries per spawn to find a spot out of every player's view; a failed spawn waits a tick. */
export const SPAWN_TRIES = 8;
/**
 * The longest side of the camera's view, units: sqrt(360,000 * 16 / 9), the 16:9 view of
 * release 1's arena area (camera.ts, arenaForViewport). Spawns stay out of a square this wide.
 */
export const VIEW_MAX = 800;
/** Extra margin around that square, units (covers the camera's smoothing lag). */
export const VIEW_PAD = 40;
/** How far past the wall the camera may look, units: camera.ts CAMERA_MARGIN. */
export const VIEW_WALL_MARGIN = 60;

// ---- Lives, waves and the streak (#55). ----

/** Hits that put you down (a revive brings you back with one hit left). */
export const HITS_PER_LIFE = 3;
/** Untouchable time after a hit, seconds (a spawn has SPAWN_PROTECT_S instead). */
export const INVULN_S = 1;
/** A life over waits this long before a press respawns you, seconds (release 1's restart guard). */
export const RESPAWN_DELAY_S = 0.8;
/** The arena's wave clock, seconds per wave. Shown, unlocks bug kinds (#65) and brings a hive queen every fifth wave (#85); never spawn volume. */
export const WAVE_S = 30;
/** Streak multiplier steps: [hits in a row, multiplier], highest first. Below the last: x1. */
export const STREAK_STEPS: readonly (readonly [number, number])[] = [
  [20, 3],
  [10, 2],
  [5, 1.5],
];

// ---- Down and revive (#59). The last hit puts you down, not out; anyone can bring you back. ----

/** How long you stay down before the life ends (bleeds out), seconds. */
export const DOWN_S = 10;
/** How long a player must stay in range to revive you, seconds. */
export const REVIVE_S = 2;
/** How close a reviver must be, centre to centre, units (inclusive). */
export const REVIVE_RANGE = 60;
/** Untouchable time after a revive, seconds. */
export const REVIVE_PROTECT_S = 1.5;
/** Points a revive scores for the reviver (and so for their team). */
export const REVIVE_POINTS = 50;
/** The browser points an arrow at the screen's edge to a downed player out of view within this, units. */
export const HELP_ARROW_RANGE = 1200;
/** The same times in ticks. */
export const DOWN_TICKS = Math.round(DOWN_S / DT);
export const REVIVE_TICKS = Math.round(REVIVE_S / DT);
export const REVIVE_PROTECT_TICKS = Math.round(REVIVE_PROTECT_S / DT);
