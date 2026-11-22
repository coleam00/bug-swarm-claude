// One arena on the server: the authoritative simulation, its members' input queues, and the tick
// that steps it and sends every member a snapshot. No timers and no clock of its own: rooms.ts
// drives `advance` from its timer, so tests step it by hand. A player going down, a revive, a
// pickup taken and a shield blocking a hit (#73) are broadcast to everyone. A life that ends (bled out while down, or its player leaving) is handed
// to `onLifeEnd` as a LifeRecord; the server saves it off the tick (lives.ts).
//
// Fill bots (#66): with `fillTo` above 0, an arena with people in it is topped up with server
// bots until people plus bots reach it, and a bot is marked to leave for each person past it. A
// marked bot leaves between its lives (at the start of the tick after its life ends); a person
// joining a full arena takes a bot's slot at once. Bots are players with no member and no socket:
// the tick drives them with the fillBot policy, and their lives are never handed to `onLifeEnd`.
//
// Watchers (#79): sockets that only watch (the start screen). They take no player slot, send no
// inputs and come and go unannounced; they get every broadcast event (never a life's "over") and
// one snapshot stream, encoded once per tick and sent to all of them.
//
// Snapshots (v10, #89, shared/arena/view.ts): the arena is quantized once a tick, then each member
// gets its own snapshot, culled to its view square, as a delta against what it was last sent or a
// keyframe (its first, every KEYFRAME_TICKS, and after a send the socket dropped). Watchers see the
// whole arena: one shared delta, and a keyframe for any watcher that is new or missed one.
//
// With `demoTo` above 0, an arena nobody plays in but someone watches runs that many bots (fill.ts
// botTarget).
import {
  HITS_PER_LIFE,
  PICKUP_IDS,
  INPUT_BUFFER,
  INPUT_STALE_TICKS,
  MAX_PLAYERS_PER_ARENA,
  TICK_MS,
  WORLD_H,
  WORLD_W,
} from "../../shared/arena/constants";
import { mult } from "../../shared/arena/combat";
import {
  BLOCK,
  DOWN,
  EVENT,
  JOIN,
  LEAVE,
  OVER,
  PICKUP,
  REVIVE,
  type ArenaEvent,
  type RosterEntry,
  type SnapshotMe,
} from "../../shared/arena/protocol";
import {
  canAct,
  clampInput,
  createArena,
  joinPlayer,
  leavePlayer,
  stepArena,
  wave,
  type ArenaState,
  type Input,
  type LifeEnd,
  type Player,
} from "../../shared/arena/sim";
import {
  createFillMemory,
  createObservation,
  fillBot,
  observe,
  type FillMemory,
  type Observation,
  type PolicyInput,
} from "../../shared/arena/policies";
import { createRng, type Rng } from "../../shared/arena/rng";
import { createArenaFrame, createViewState, encodeView, keyframeOf, quantizeArena, viewBoxOf, type ArenaFrame, type ViewBox, type ViewState } from "../../shared/arena/view";
import type { Team } from "../rules";
import { botName, botTeam, botTarget, fillDelta } from "./fill";
import type { TickLog } from "./ticks";

/** Sends one text frame to a member's socket. False when the socket dropped it (its next snapshot is a keyframe). */
export type Send = (message: string) => boolean;

/** A finished life, as the server saves it: who played it, and what the simulation scored. */
export type LifeRecord = {
  /** The browser's player id from the hello. */
  playerKey: string;
  name: string;
  team: Team;
  touch: boolean;
  score: number;
  kills: number;
  seconds: number;
  /** Wall-clock time it ended, ms. */
  endedAtMs: number;
};

/** Who a member is beyond their robot: the hello's player id and touch flag. */
export type MemberInfo = { playerKey: string; touch: boolean };

type Member = MemberInfo & {
  player: Player;
  send: Send;
  /** Inputs waiting for a tick, oldest first; at most INPUT_BUFFER. */
  queue: Input[];
  /** The last input sequence number applied by a tick (0 before any): the snapshot's `ack`. */
  ack: number;
  /** The last sequence number accepted into the queue; older or repeated ones are dropped. */
  lastSeq: number;
  /** What this member was last sent (view.ts). */
  view: ViewState;
};

/** A watching socket: its send, and whether its next snapshot must be a keyframe. */
type Watcher = { send: Send; needKey: boolean };

/** A server fill bot: its player, and what its policy sees and remembers. */
type Bot = { player: Player; obs: Observation; mem: FillMemory; rng: Rng; out: PolicyInput; leaving: boolean };

/** A watcher's snapshot numbers: all zero (it has no robot). Shared, never written. */
const WATCH_ME: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0, fx: PICKUP_IDS.map(() => 0), x: 0, y: 0, vx: 0, vy: 0 };

/** Ticks a late timer may run at once to catch up; any further lag is dropped, not caught up. */
export const MAX_CATCH_UP_TICKS = 2;

/** A player's own snapshot numbers, into `out`. */
export function meOf(p: Player, out: SnapshotMe): SnapshotMe {
  out.sc = p.score;
  out.ki = p.kills;
  out.st = p.streak;
  out.mu = mult(p.streak);
  out.he = p.heat;
  out.lk = p.lockTicks > 0 ? 1 : 0;
  out.hl = canAct(p) ? HITS_PER_LIFE - p.hits : 0;
  out.al = p.alive ? 1 : 0;
  out.dk = p.dashTicks;
  out.dc = p.dashCooldown;
  out.dn = p.down ? 1 : 0;
  out.x = p.x;
  out.y = p.y;
  out.vx = p.vx;
  out.vy = p.vy;
  // Filled in place: the array is the room's, reused every snapshot.
  out.fx.length = p.effect.length;
  for (let i = 0; i < p.effect.length; i++) out.fx[i] = p.effect[i]!;
  return out;
}

export class Room {
  readonly state: ArenaState;
  private readonly members = new Map<number, Member>();
  /** Fill bots by player id, oldest first. */
  private readonly bots = new Map<number, Bot>();
  /** Watching sockets by watcher id (rooms.ts numbers them). */
  private readonly watchers = new Map<number, Watcher>();
  /** What every watcher was sent: they share one stream. */
  private readonly watchView: ViewState = createViewState();
  /** This tick's arena, quantized once for every snapshot (view.ts). */
  private readonly frame: ArenaFrame = createArenaFrame();
  private readonly box: ViewBox = { cx: 0, cy: 0, half: 0 };
  private nextTickAt: number;
  /** Running warmUp: the arena plays as a watched demo arena with nobody to send to. */
  private warming = false;
  private readonly me: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0, fx: [], x: 0, y: 0, vx: 0, vy: 0 };

  constructor(
    readonly id: number,
    private readonly seed: number,
    startMs: number,
    private readonly ticks: TickLog,
    private readonly clock: () => number = () => performance.now(),
    private readonly onLifeEnd: (r: LifeRecord) => void = () => {},
    /** People plus fill bots to top the arena up to; 0: no fill bots are managed. */
    private readonly fillTo = 0,
    /** Bots an arena with watchers and no people runs; 0: none. */
    private readonly demoTo = 0,
  ) {
    this.state = createArena(seed);
    this.nextTickAt = startMs + TICK_MS;
  }

  /** People in the arena (members). Bots and watchers never count: capacity goes by people. */
  get size(): number {
    return this.members.size;
  }

  get botCount(): number {
    return this.bots.size;
  }

  get watcherCount(): number {
    return this.watchers.size;
  }

  /** Adds a watcher, silently: nobody is told, the roster does not change. Its first snapshot is a keyframe. */
  watch(id: number, send: Send): void {
    this.watchers.set(id, { send, needKey: true });
    this.markLeaving();
  }

  unwatch(id: number): void {
    if (this.watchers.delete(id)) this.markLeaving();
  }

  /** People plus bots the arena should hold now (fill.ts botTarget). */
  private target(): number {
    return botTarget(this.members.size, this.warming ? 1 : this.watchers.size, this.fillTo, this.demoTo);
  }

  /** The arena's wave now (1 up), as the snapshot sends it. */
  get wave(): number {
    return wave(this.state.tick);
  }

  /** Adds a fill bot now and tells everyone. The tick tops arenas up; tests call it directly. */
  addBot(): Player {
    const used = (n: string) => this.state.players.some((p) => p.name === n);
    const player = joinPlayer(this.state, botName(used), botTeam(this.state.players));
    this.bots.set(player.id, {
      player,
      obs: createObservation(),
      mem: createFillMemory(),
      // Its own generator, never the arena's, so bots never change the arena's draws.
      rng: createRng(Math.imul(this.seed ^ player.id, 0x9e3779b1)),
      out: { mx: 0, my: 0, aim: 0, fire: false, dash: false },
      leaving: false,
    });
    this.broadcast({ t: EVENT, kind: JOIN, id: player.id, name: player.name, team: player.team });
    return player;
  }

  /** Takes a fill bot out and tells everyone. Its life, if any, is dropped: bot lives are never saved. */
  private removeBot(id: number): void {
    if (!this.bots.delete(id)) return;
    leavePlayer(this.state, id);
    this.broadcast({ t: EVENT, kind: LEAVE, id });
  }

  /** Marks the newest bots past the fill target to leave between lives, and unmarks the rest. */
  private markLeaving(): void {
    const target = this.target();
    if (target <= 0) return;
    const leave = Math.max(0, -fillDelta(this.members.size, this.bots.size, target));
    let i = 0;
    for (const b of this.bots.values()) b.leaving = i++ >= this.bots.size - leave;
  }

  /** A bot to evict for a person joining a full arena: one already leaving, else one out, else the newest. */
  private botToEvict(): number {
    let out = -1;
    let newest = -1;
    for (const b of this.bots.values()) {
      if (b.leaving) return b.player.id;
      if (out < 0 && !b.player.alive) out = b.player.id;
      newest = b.player.id;
    }
    return out >= 0 ? out : newest;
  }

  roster(): RosterEntry[] {
    return this.state.players.map((p) => ({ id: p.id, name: p.name, team: p.team }));
  }

  /**
   * Adds a member and tells everyone else. Returns their player. In a full arena a bot gives up
   * its slot first; bots past the fill target are marked to leave. Bots are never added here: the
   * caller sends the welcome after this returns, and nothing may reach the newcomer before it.
   */
  add(name: string, team: Team, info: MemberInfo, send: Send): Player {
    if (this.bots.size > 0 && this.state.players.length >= MAX_PLAYERS_PER_ARENA) this.removeBot(this.botToEvict());
    const player = joinPlayer(this.state, name, team);
    this.broadcast({ t: EVENT, kind: JOIN, id: player.id, name, team });
    this.members.set(player.id, { playerKey: info.playerKey, touch: info.touch, player, send, queue: [], ack: 0, lastSeq: 0, view: createViewState() });
    this.markLeaving();
    return player;
  }

  /** Every member's entity id, as a new array (safe to remove members while walking it). */
  memberIds(): number[] {
    return [...this.members.keys()];
  }

  /**
   * Removes a member and tells everyone left. A life in progress ends here and is saved, so a
   * disconnect or a server shutting down never loses a score (a reconnect starts a new life).
   * Returns true when it ended a life (false for a member already out, or not here).
   */
  remove(id: number, nowMs: number): boolean {
    const m = this.members.get(id);
    if (!m) return false;
    this.members.delete(id);
    const left = leavePlayer(this.state, id);
    if (left?.life) this.lifeEnded(m, left.life, nowMs);
    this.broadcast({ t: EVENT, kind: LEAVE, id });
    this.markLeaving();
    return Boolean(left?.life);
  }

  /**
   * Queues a member's input for the next free tick. An input whose sequence number is not newer
   * than the last one accepted is dropped; a full queue drops its oldest, carrying its dash press
   * onto the next one, so a press is never lost (the browser has already predicted the dash).
   */
  pushInput(id: number, input: Input): void {
    const m = this.members.get(id);
    if (!m || input.seq <= m.lastSeq) return;
    m.lastSeq = input.seq;
    if (m.queue.length >= INPUT_BUFFER && m.queue.shift()!.dash) m.queue[0]!.dash = true;
    m.queue.push(clampInput(input));
  }

  /** Runs the ticks owed by `nowMs` (at most MAX_CATCH_UP_TICKS). Returns how many ran. */
  advance(nowMs: number): number {
    let ran = 0;
    while (nowMs >= this.nextTickAt && ran < MAX_CATCH_UP_TICKS) {
      this.tick(nowMs);
      this.nextTickAt += TICK_MS;
      ran++;
    }
    if (nowMs >= this.nextTickAt) this.nextTickAt = nowMs + TICK_MS;
    return ran;
  }

  /**
   * Fill bots, at the start of a tick: bots marked to leave go once out of a life (never
   * respawning first: a respawn takes RESPAWN_DELAY_S of presses), the arena is topped up to the
   * fill target (their joins go out before this tick's snapshot), and every bot's policy writes
   * its input for this step, in place (no new input objects; adding a bot allocates its state).
   */
  private driveBots(): void {
    const target = this.target();
    if (target > 0) {
      for (const b of this.bots.values()) if (b.leaving && !b.player.alive) this.removeBot(b.player.id);
      const add = Math.min(fillDelta(this.members.size, this.bots.size, target), MAX_PLAYERS_PER_ARENA - this.state.players.length);
      for (let i = 0; i < add; i++) this.addBot();
      this.markLeaving();
    }
    for (const b of this.bots.values()) {
      const p = b.player;
      observe(this.state, p.id, WORLD_W, WORLD_H, b.obs);
      fillBot(b.obs, b.mem, b.rng, b.out);
      const o = b.out;
      const input = p.input;
      input.seq = 0;
      input.mx = o.mx;
      input.my = o.my;
      input.aim = o.aim;
      input.fire = o.fire;
      input.dash = o.dash;
      clampInput(input);
      p.idleTicks = 0;
    }
  }

  /**
   * One tick: fill bots first (driveBots), then each member's next queued input becomes its current one (a held input repeats
   * while the queue is empty, its move and fire stopped once INPUT_STALE_TICKS pass with nothing
   * new), the arena steps, everyone is told of each player who went down and then of each
   * revive, every life that ended is handed on and its player told, and every member gets a
   * snapshot with its own ack and numbers (pickups taken and shield blocks are broadcast with the
   * downs and revives). Events of a tick are sent before its snapshot. The arena is quantized once
   * (view.ts quantizeArena); each member's snapshot is culled to its view and encoded against what
   * it was last sent.
   */
  tick(nowMs: number): void {
    const t0 = this.clock();
    this.step(nowMs);
    this.ticks.record(nowMs, this.clock() - t0);
  }

  /**
   * Runs `ticks` ticks at once, as a watched demo arena, before anyone is in it or watching it
   * (#79), so its bots are already fighting when its first watcher arrives. Nothing is sent (there
   * is nobody to send to) and the ticks are not in the stats. Rooms calls it only when nobody plays
   * anywhere on the server, so the time it takes holds up no player.
   */
  warmUp(ticks: number, nowMs: number): void {
    if (this.members.size > 0 || this.watchers.size > 0) return;
    this.warming = true;
    for (let i = 0; i < ticks; i++) this.step(nowMs);
    this.warming = false;
  }

  /** One tick's work (see tick). */
  private step(nowMs: number): void {
    this.driveBots();
    for (const m of this.members.values()) {
      const p = m.player;
      const next = m.queue.shift();
      if (next) {
        p.input = next;
        p.idleTicks = 0;
        m.ack = next.seq;
      } else if (++p.idleTicks >= INPUT_STALE_TICKS) {
        p.input.mx = 0;
        p.input.my = 0;
        p.input.fire = false;
      }
      // A dash is one press (and while out, the respawn), never repeated by a held input.
      if (!next) p.input.dash = false;
    }
    stepArena(this.state);
    const ev = this.state.events;
    for (const id of ev.downs) this.broadcast({ t: EVENT, kind: DOWN, id });
    for (const r of ev.revives) this.broadcast({ t: EVENT, kind: REVIVE, id: r.id, by: r.by, points: r.points });
    for (const x of ev.pickups) this.broadcast({ t: EVENT, kind: PICKUP, id: x.player, pickup: PICKUP_IDS.indexOf(x.kind) });
    for (const id of ev.blocks) this.broadcast({ t: EVENT, kind: BLOCK, id });
    for (const life of this.state.events.livesEnded) {
      // A fill bot is not a member, so its lives end here unsaved and unannounced.
      const m = this.members.get(life.id);
      if (m) this.lifeEnded(m, life, nowMs);
    }
    // Quantized even with nobody to send to (a warm-up), so shot ends always find where their shot started.
    const f = quantizeArena(this.state, wave(this.state.tick), this.frame);
    for (const m of this.members.values()) {
      const p = m.player;
      const msg = encodeView(f, m.view, viewBoxOf(p.x, p.y, this.box), p.id, m.ack, meOf(p, this.me));
      if (!m.send(msg)) m.view.needKey = true;
    }
    if (this.watchers.size > 0) this.sendWatchers(f);
  }

  /**
   * One stream for every watcher: the delta (or keyframe) the shared view moved by, and a keyframe
   * for each watcher that is new or had a send dropped. A dropped send marks only that watcher.
   */
  private sendWatchers(f: ArenaFrame): void {
    const vs = this.watchView;
    let behind = 0;
    for (const w of this.watchers.values()) if (w.needKey) behind++;
    // Everyone needs a keyframe: make the shared one a keyframe rather than encode both.
    if (behind === this.watchers.size) vs.needKey = true;
    const msg = encodeView(f, vs, null, 0, 0, WATCH_ME);
    let key: string | null = vs.wasKey ? msg : null;
    for (const w of this.watchers.values()) {
      let out = msg;
      if (w.needKey && !vs.wasKey) out = key ??= keyframeOf(f, vs, null, 0, 0, WATCH_ME);
      w.needKey = !w.send(out);
    }
  }

  /** Hands a finished life on to be saved, and tells its player (if still connected) it is over. */
  private lifeEnded(m: Member, life: LifeEnd, nowMs: number): void {
    const seconds = (life.ticks * TICK_MS) / 1000; // ticks * DT would leave float noise
    this.onLifeEnd({
      playerKey: m.playerKey,
      name: m.player.name,
      team: m.player.team,
      touch: m.touch,
      score: life.score,
      kills: life.kills,
      seconds,
      endedAtMs: nowMs,
    });
    if (this.members.has(life.id)) {
      const over: ArenaEvent = { t: EVENT, kind: OVER, id: life.id, score: life.score, kills: life.kills, seconds };
      m.send(JSON.stringify(over));
    }
  }

  private broadcast(event: ArenaEvent): void {
    const msg = JSON.stringify(event);
    for (const m of this.members.values()) m.send(msg);
    for (const w of this.watchers.values()) w.send(msg);
  }
}
