// Every tuning number of the arena (release 2), in one place. Shared by the server (authoritative)
// and the browser (prediction of your own robot), so both step with the same numbers.

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

/** New players spawn at least this far from every wall. */
export const SPAWN_MARGIN = 300;

/** The most players in one arena. */
export const MAX_PLAYERS_PER_ARENA = 20;
/** Inputs the server queues per player; one is applied each tick, the oldest dropped past this. */
export const INPUT_BUFFER = 4;
/** Ticks with no new input after which a player's move is zeroed (500 ms). */
export const INPUT_STALE_TICKS = 10;
/** Inputs a socket may send per second; the rest are dropped. */
export const INPUTS_PER_SECOND = 30;
/** The biggest client message the server reads, UTF-8 bytes. */
export const MAX_CLIENT_MESSAGE_BYTES = 1024;
/** The protocol version. A hello with another one is refused with error "version". */
export const PROTOCOL_VERSION = 1;
/** How far behind the server the browser draws other players, ms. */
export const INTERP_DELAY_MS = 100;
