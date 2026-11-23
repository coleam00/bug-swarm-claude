// The room manager: which arena a player joins, one tick timer per arena, and the stats. A player
// joins the fullest arena with people that still has room for a person (ties: the oldest), else a
// new one opens; an arena closes, timer, fill bots and all, once its last person and its last
// watcher have left. Arenas are topped up to `fillTo` with server fill bots (room.ts); capacity and
// "fullest" count people only, so a bot never takes a slot a person needs. The timer and the clock
// are injected, so tests step arenas by hand and never wait on real time.
//
// Watchers (#79, the start screen): at most `maxWatchers` server-wide. A watch lands in the arena
// with the most people, else the people-less arena with the most watchers, else a new arena (the
// demo arena: `demoTo` bots and no people, run DEMO_WARM_S forward first so its bots are already
// fighting). An arena with no people is never picked for a join
// (fair drop-in: a demo arena may be on a late wave) and never shown on the board. While anyone
// watches, every WATCH_SWEEP_MS `rehome` moves the watchers of people-less arenas to the busiest
// arena with people, with a fresh welcome, so a start screen opened on an empty server shows the
// people once they come.
//
// The people cap (#104): `full` is true once `maxPeople` play across every arena. The sockets
// check it before a join and refuse the hello with `busy`, so past the cap no arena opens.
//
// Active people (#117): "people" above means the members who count now (Room.people): not hidden
// and not out for OUT_IDLE_S. Joins, watches, rehoming and the board go by them; the people cap and
// the load stats go by members, and an arena closes only once no member, away socket or watcher is
// left. A member moved away to free a slot (room.ts) comes back on their play press (`input` with a
// dash): to their arena if it can take them, else to the arena a join would pick, with a fresh
// welcome sent on their socket and never a refusal.
import {
  DEMO_BOTS,
  DEMO_WARM_TICKS,
  FILL_TARGET,
  MAX_PEOPLE,
  MAX_PLAYERS_PER_ARENA,
  MAX_WATCHERS,
  PROTOCOL_VERSION,
  TICK_MS,
  WATCH_SWEEP_MS,
  WORLD_H,
  WORLD_W,
} from "../../shared/arena/constants";
import { WELCOME, type Welcome } from "../../shared/arena/protocol";
import type { Input } from "../../shared/arena/sim";
import type { Team } from "../rules";
import { Room, type Away, type LifeRecord, type MemberInfo, type Send } from "./room";
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
  /**
   * Called with every finished life, from inside a tick or a leave, so it must not touch the
   * database there (lives.ts queues the write). Fill bots' lives never reach it. Defaults to
   * dropping it.
   */
  saveLife?: (r: LifeRecord) => void;
  /** People plus fill bots each arena with people is topped up to (default FILL_TARGET; 0: no bots). */
  fillTo?: number;
  /** Sockets that may watch at once, server-wide (default MAX_WATCHERS). */
  maxWatchers?: number;
  /** People who may play at once, server-wide (default MAX_PEOPLE); `full` says when they do. */
  maxPeople?: number;
  /** Bots a watched arena with no people runs (default DEMO_BOTS; 0: none). */
  demoTo?: number;
  /** Each new arena's first tick (default 0; BUG_SWARM_START_WAVE, a debug aid, #85). */
  startTick?: number;
  /** The process's memory, MB, for the stats (default process.memoryUsage; tests pass their own). */
  memory?: () => { rssMb: number; heapUsedMb: number };
};

/**
 * `players` counts people only; `bots` the server's fill bots; `watchers` the watching sockets;
 * `memory` the server process's resident set and JS heap in use, MB (#89, for `bun run bots`).
 */
export type ArenaStats = {
  arenas: { id: number; players: number; bots: number; watchers: number }[];
  players: number;
  bots: number;
  watchers: number;
  tick: { p50: number | null; p95: number | null };
  memory: { rssMb: number; heapUsedMb: number };
};

const MB = 1024 * 1024;
const processMemory = () => {
  const m = process.memoryUsage();
  return { rssMb: Math.round((m.rss / MB) * 10) / 10, heapUsedMb: Math.round((m.heapUsed / MB) * 10) / 10 };
};

/**
 * One open arena as the stream board shows it: people only, never fill bots. `queen` is her health
 * in whole percent, 1-100, while a hive queen is alive in the arena (#102); null with none or only
 * her marker.
 */
export type LiveArena = { id: number; players: number; wave: number; queen: number | null };
/** What the stream board reads live (GET /api/board): `playing` is the sum of the arenas' people (active ones, #117). */
export type LiveArenas = { playing: number; arenas: LiveArena[] };

export type Joined = { room: number; entity: number; welcome: Welcome };
export type Watching = { watcher: number; welcome: Welcome };

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
  private readonly saveLife: (r: LifeRecord) => void;
  private readonly fillTo: number;
  private readonly maxWatchers: number;
  private readonly maxPeople: number;
  private readonly demoTo: number;
  private readonly startTick: number;
  private readonly memory: () => { rssMb: number; heapUsedMb: number };
  /** Every watcher: the arena it watches and its socket's send. */
  private readonly watchers = new Map<number, { room: number; send: Send }>();
  private nextWatcher = 1;
  /** Stops the rehome timer; set while anyone watches. */
  private stopSweep: (() => void) | null = null;

  constructor(opts: RoomsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.clock = opts.clock ?? (() => performance.now());
    this.startTimer = opts.startTimer ?? realTimer;
    this.buildId = opts.buildId ?? String(Date.now());
    this.saveLife = opts.saveLife ?? (() => {});
    this.fillTo = opts.fillTo ?? FILL_TARGET;
    this.maxWatchers = opts.maxWatchers ?? MAX_WATCHERS;
    this.maxPeople = opts.maxPeople ?? MAX_PEOPLE;
    this.demoTo = opts.demoTo ?? DEMO_BOTS;
    this.startTick = opts.startTick ?? 0;
    this.memory = opts.memory ?? processMemory;
  }

  private welcome(room: Room, you: number): Welcome {
    return {
      t: WELCOME,
      v: PROTOCOL_VERSION,
      you,
      arena: room.id,
      build: this.buildId,
      world: { w: WORLD_W, h: WORLD_H },
      tickMs: TICK_MS,
      tick: room.state.tick,
      roster: room.roster(),
    };
  }

  /**
   * True when `maxPeople` play across every arena: the caller refuses the join (`busy`) instead of
   * calling `join`. Read per hello, never in the tick.
   */
  get full(): boolean {
    let people = 0;
    for (const { room } of this.rooms.values()) people += room.size;
    return people >= this.maxPeople;
  }

  /** Puts a player in an arena; everyone already there gets a join event. Check `full` first. */
  join(name: string, team: Team, info: MemberInfo, send: Send): Joined {
    const room = this.pick();
    const player = room.add(name, team, info, send);
    return { room: room.id, entity: player.id, welcome: this.welcome(room, player.id) };
  }

  /** Takes a player out; everyone left gets a leave event. The arena closes once nobody plays in or watches it. */
  leave(roomId: number, entity: number): void {
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    entry.room.remove(entity, this.now());
    this.closeIfEmpty(roomId);
  }

  /**
   * Queues a member's input. From a member moved away (#117) only a play press (dash) counts: it
   * joins them again and returns where (the welcome already sent on their socket), so the caller
   * now knows them by the new room and entity. Else null.
   */
  input(roomId: number, entity: number, input: Input): Joined | null {
    const room = this.rooms.get(roomId)?.room;
    if (!room) return null;
    if (!room.isAway(entity)) {
      room.pushInput(entity, input);
      return null;
    }
    if (!input.dash) return null;
    return this.comeBack(room, room.takeAway(entity)!);
  }

  /** The page says its tab is hidden or shown again (#117). */
  visibility(roomId: number, entity: number, hidden: boolean): void {
    this.rooms.get(roomId)?.room.setHidden(entity, hidden);
  }

  /**
   * A member moved away presses play: back into their arena if it can take them, else into the one
   * a join would pick (never refused: the socket was admitted already). The welcome goes out on
   * their socket at once, before any tick of the arena can reach it.
   */
  private comeBack(from: Room, a: Away): Joined {
    const to = from.canTake() ? from : this.pick();
    const player = to.add(a.name, a.team, a.info, a.send);
    const welcome = this.welcome(to, player.id);
    a.send(JSON.stringify(welcome));
    if (to !== from) this.closeIfEmpty(from.id);
    return { room: to.id, entity: player.id, welcome };
  }

  /**
   * Starts a socket watching an arena (the start screen): the busiest arena with people, else the
   * watched arena with none, else a new demo arena. Returns null at the watcher cap. Nobody in the
   * arena is told. The caller sends the welcome (`you` 0) before anything else reaches `send`.
   */
  watch(send: Send): Watching | null {
    if (this.watchers.size >= this.maxWatchers) return null;
    let room = this.busiest() ?? this.mostWatched();
    if (!room) {
      // A new demo arena. Nobody plays anywhere (else busiest() found them), so the warm-up holds up no one.
      room = this.open();
      if (this.demoTo > 0) room.warmUp(DEMO_WARM_TICKS, this.now());
    }
    const watcher = this.nextWatcher++;
    this.watchers.set(watcher, { room: room.id, send });
    room.watch(watcher, send);
    if (!this.stopSweep) this.stopSweep = this.startTimer(() => this.rehome(), WATCH_SWEEP_MS);
    return { watcher, welcome: this.welcome(room, 0) };
  }

  /** Stops a watcher; its arena closes if nobody plays in or watches it any more. */
  unwatch(watcher: number): void {
    const w = this.watchers.get(watcher);
    if (!w) return;
    this.watchers.delete(watcher);
    this.rooms.get(w.room)?.room.unwatch(watcher);
    this.closeIfEmpty(w.room);
    if (this.watchers.size === 0) this.endSweep();
  }

  /**
   * Moves every watcher of an arena with no people to the busiest arena with people, if there is
   * one, and sends it that arena's welcome; the arenas left empty close. Runs every WATCH_SWEEP_MS
   * while anyone watches (tests call it directly).
   */
  rehome(): void {
    const to = this.busiest();
    if (!to) return;
    for (const [id, w] of this.watchers) {
      const from = this.rooms.get(w.room)?.room;
      if (!from || from.people > 0) continue;
      from.unwatch(id);
      w.room = to.id;
      // The welcome first: the next tick's snapshot must not reach the watcher before it.
      w.send(JSON.stringify(this.welcome(to, 0)));
      to.watch(id, w.send);
      this.closeIfEmpty(from.id);
    }
  }

  /** The arena with this id, for tests. */
  room(id: number): Room | undefined {
    return this.rooms.get(id)?.room;
  }

  stats(): ArenaStats {
    const arenas = [...this.rooms.values()].map(({ room }) => ({ id: room.id, players: room.size, bots: room.botCount, watchers: room.watcherCount }));
    return {
      arenas,
      players: arenas.reduce((n, a) => n + a.players, 0),
      bots: arenas.reduce((n, a) => n + a.bots, 0),
      watchers: this.watchers.size,
      tick: this.ticks.percentiles(this.now()),
      memory: this.memory(),
    };
  }

  /**
   * The open arenas for the stream board, by id, with their people (active ones, #117; bots never
   * count), wave and hive queen's health. Read per HTTP request, never in the tick. An arena nobody
   * plays in (only watched: the start screen's demo arena, or every member out or hidden) is left
   * out, so every arena listed has at least one person.
   */
  live(): LiveArenas {
    const arenas: LiveArena[] = [];
    for (const { room } of this.rooms.values()) {
      const people = room.people;
      if (people > 0) arenas.push({ id: room.id, players: people, wave: room.wave, queen: room.queen });
    }
    arenas.sort((a, b) => a.id - b.id);
    return { playing: arenas.reduce((n, a) => n + a.players, 0), arenas };
  }

  /**
   * The server is stopping: takes every player out of every arena, which ends and saves each life
   * in progress with its score so far (Room.remove), then stops every timer and forgets the arenas
   * and the watchers. Returns how many lives it ended. Sends nothing to the sockets.
   */
  endAll(): number {
    let ended = 0;
    for (const { room, stop } of this.rooms.values()) {
      for (const id of room.memberIds()) if (room.remove(id, this.now())) ended++;
      stop();
    }
    this.rooms.clear();
    this.watchers.clear();
    this.endSweep();
    return ended;
  }

  /**
   * The arena with the most people that can take one more (Room.canTake; ties: the lowest id), else
   * a new one. An arena with no people (only watched, or every member out or hidden) is never
   * picked: it may be on a late wave, and nobody would play with the newcomer.
   */
  private pick(): Room {
    let best: Room | null = null;
    let bestPeople = 0;
    for (const { room } of this.rooms.values()) {
      const people = room.people;
      if (people === 0 || !room.canTake()) continue;
      if (!best || people > bestPeople || (people === bestPeople && room.id < best.id)) {
        best = room;
        bestPeople = people;
      }
    }
    return best ?? this.open();
  }

  /** The arena with the most people, full or not (ties: the lowest id); null when nobody plays. */
  private busiest(): Room | null {
    let best: Room | null = null;
    let bestPeople = 0;
    for (const { room } of this.rooms.values()) {
      const people = room.people;
      if (people === 0) continue;
      if (!best || people > bestPeople || (people === bestPeople && room.id < best.id)) {
        best = room;
        bestPeople = people;
      }
    }
    return best;
  }

  /** The arena with no people and the most watchers (ties: the lowest id), or null. */
  private mostWatched(): Room | null {
    let best: Room | null = null;
    for (const { room } of this.rooms.values()) {
      if (room.size > 0 || room.watcherCount === 0) continue;
      if (!best || room.watcherCount > best.watcherCount || (room.watcherCount === best.watcherCount && room.id < best.id)) best = room;
    }
    return best;
  }

  /** Opens a new arena and starts its tick timer. */
  private open(): Room {
    const id = this.nextId++;
    const room = new Room(id, arenaSeed(id), this.now(), this.ticks, this.clock, this.saveLife, this.fillTo, this.demoTo, this.startTick);
    const stop = this.startTimer(() => room.advance(this.now()), TICK_MS);
    this.rooms.set(id, { room, stop });
    return room;
  }

  private closeIfEmpty(roomId: number): void {
    const entry = this.rooms.get(roomId);
    if (!entry || entry.room.size > 0 || entry.room.awayCount > 0 || entry.room.watcherCount > 0) return;
    entry.stop();
    this.rooms.delete(roomId);
  }

  private endSweep(): void {
    this.stopSweep?.();
    this.stopSweep = null;
  }
}
