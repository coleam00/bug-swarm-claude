// The room manager: which arena a player joins, one tick timer per arena, and the stats. A player
// joins the fullest arena that still has room (ties: the oldest), else a new one opens; an arena
// closes, timer and all, when its last player leaves. The timer and the clock are injected, so
// tests step arenas by hand and never wait on real time.
import { MAX_PLAYERS_PER_ARENA, PROTOCOL_VERSION, TICK_MS, WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { WELCOME, type Welcome } from "../../shared/arena/protocol";
import type { Input } from "../../shared/arena/sim";
import type { Team } from "../rules";
import { Room, type Send } from "./room";
import { createTickLog, type TickLog } from "./ticks";

/** Starts calling `fn` every `ms`; returns the function that stops it. */
export type StartTimer = (fn: () => void, ms: number) => () => void;

export type RoomsOptions = {
  /** Wall clock, ms (tick timestamps for the stats window). */
  now?: () => number;
  /** High-resolution clock, ms (tick durations). */
  clock?: () => number;
  startTimer?: StartTimer;
  /** Sent in every welcome, so a client can tell the server was redeployed. */
  buildId?: string;
};

export type ArenaStats = {
  arenas: { id: number; players: number; bots: number }[];
  players: number;
  tick: { p50: number | null; p95: number | null };
};

export type Joined = { room: number; entity: number; welcome: Welcome };

const realTimer: StartTimer = (fn, ms) => {
  const t = setInterval(fn, ms);
  return () => clearInterval(t);
};

/** Each arena's generator seed, from its id (Knuth's multiplicative hash), so arenas differ. */
export function arenaSeed(id: number): number {
  return Math.imul(id, 2654435761) | 0;
}

export class Rooms {
  private readonly rooms = new Map<number, { room: Room; stop: () => void }>();
  private nextId = 1;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly startTimer: StartTimer;
  readonly buildId: string;
  readonly ticks: TickLog = createTickLog();

  constructor(opts: RoomsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? (() => performance.now());
    this.startTimer = opts.startTimer ?? realTimer;
    this.buildId = opts.buildId ?? String(Date.now());
  }

  /** Puts a player in an arena; everyone already there gets a join event. */
  join(name: string, team: Team, send: Send): Joined {
    const room = this.pick();
    const player = room.add(name, team, send);
    const welcome: Welcome = {
      t: WELCOME,
      v: PROTOCOL_VERSION,
      you: player.id,
      arena: room.id,
      build: this.buildId,
      world: { w: WORLD_W, h: WORLD_H },
      tickMs: TICK_MS,
      tick: room.state.tick,
      roster: room.roster(),
    };
    return { room: room.id, entity: player.id, welcome };
  }

  /** Takes a player out; everyone left gets a leave event. The last one out closes the arena. */
  leave(roomId: number, entity: number): void {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.room.remove(entity);
    if (entry.room.size === 0) {
      entry.stop();
      this.rooms.delete(roomId);
    }
  }

  input(roomId: number, entity: number, input: Input): void {
    this.rooms.get(roomId)?.room.pushInput(entity, input);
  }

  /** The arena with this id, for tests. */
  room(id: number): Room | undefined {
    return this.rooms.get(id)?.room;
  }

  stats(): ArenaStats {
    const arenas = [...this.rooms.values()].map(({ room }) => ({ id: room.id, players: room.size, bots: 0 }));
    return {
      arenas,
      players: arenas.reduce((n, a) => n + a.players, 0),
      tick: this.ticks.percentiles(this.now()),
    };
  }

  /** Stops every arena's timer. */
  close(): void {
    for (const { stop } of this.rooms.values()) stop();
    this.rooms.clear();
  }

  /** The fullest arena with room (ties: the lowest id), else a new one. */
  private pick(): Room {
    let best: Room | null = null;
    for (const { room } of this.rooms.values()) {
      if (room.size >= MAX_PLAYERS_PER_ARENA) continue;
      if (!best || room.size > best.size || (room.size === best.size && room.id < best.id)) best = room;
    }
    if (best) return best;
    const id = this.nextId++;
    const room = new Room(id, arenaSeed(id), this.now(), this.ticks, this.clock);
    const stop = this.startTimer(() => room.advance(this.now()), TICK_MS);
    this.rooms.set(id, { room, stop });
    return room;
  }
}
