// One arena on the server: the authoritative simulation, its members' input queues, and the tick
// that steps it and sends every member a snapshot. No timers and no clock of its own: rooms.ts
// drives `advance` from its timer, so tests step it by hand. A life that ends (out, or its player
// leaving) is handed to `onLifeEnd` as a LifeRecord; the server saves it off the tick (lives.ts).
import { BUG_KINDS, HITS_PER_LIFE, INPUT_BUFFER, INPUT_STALE_TICKS, TICK_MS } from "../../shared/arena/constants";
import { mult } from "../../shared/arena/combat";
import {
  EVENT,
  JOIN,
  LEAVE,
  OVER,
  encodeSnapshot,
  encodeSnapshotShared,
  type ArenaEvent,
  type RosterEntry,
  type SnapshotMe,
} from "../../shared/arena/protocol";
import {
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
import type { Team } from "../rules";
import type { TickLog } from "./ticks";

/** Sends one text frame to a member's socket. */
export type Send = (message: string) => void;

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
};

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
  out.hl = p.alive ? HITS_PER_LIFE - p.hits : 0;
  out.al = p.alive ? 1 : 0;
  return out;
}

export class Room {
  readonly state: ArenaState;
  private readonly members = new Map<number, Member>();
  private nextTickAt: number;
  private readonly me: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0 };

  constructor(
    readonly id: number,
    seed: number,
    startMs: number,
    private readonly ticks: TickLog,
    private readonly clock: () => number = () => performance.now(),
    private readonly onLifeEnd: (r: LifeRecord) => void = () => {},
  ) {
    this.state = createArena(seed);
    this.nextTickAt = startMs + TICK_MS;
  }

  get size(): number {
    return this.members.size;
  }

  roster(): RosterEntry[] {
    return this.state.players.map((p) => ({ id: p.id, name: p.name, team: p.team }));
  }

  /** Adds a member and tells everyone else. Returns their player. */
  add(name: string, team: Team, info: MemberInfo, send: Send): Player {
    const player = joinPlayer(this.state, name, team);
    this.broadcast({ t: EVENT, kind: JOIN, id: player.id, name, team });
    this.members.set(player.id, { playerKey: info.playerKey, touch: info.touch, player, send, queue: [], ack: 0, lastSeq: 0 });
    return player;
  }

  /**
   * Removes a member and tells everyone left. A life in progress ends here and is saved, so a
   * disconnect never loses a score (a reconnect starts a new life).
   */
  remove(id: number, nowMs: number): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    const left = leavePlayer(this.state, id);
    if (left?.life) this.lifeEnded(m, left.life, nowMs);
    this.broadcast({ t: EVENT, kind: LEAVE, id });
  }

  /**
   * Queues a member's input for the next free tick. An input whose sequence number is not newer
   * than the last one accepted is dropped; a full queue drops its oldest.
   */
  pushInput(id: number, input: Input): void {
    const m = this.members.get(id);
    if (!m || input.seq <= m.lastSeq) return;
    m.lastSeq = input.seq;
    if (m.queue.length >= INPUT_BUFFER) m.queue.shift();
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
   * One tick: each member's next queued input becomes its current one (a held input repeats
   * while the queue is empty, its move and fire stopped once INPUT_STALE_TICKS pass with nothing
   * new), the arena steps, every life that ended is handed on and its player told, and every
   * member gets a snapshot with its own ack and numbers. The shared part of the snapshot is
   * encoded once for everyone.
   */
  tick(nowMs: number): void {
    const t0 = this.clock();
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
    for (const life of this.state.events.livesEnded) {
      const m = this.members.get(life.id);
      if (m) this.lifeEnded(m, life, nowMs);
    }
    const shared = encodeSnapshotShared(this.state, BUG_KINDS, wave(this.state.tick));
    for (const m of this.members.values()) m.send(encodeSnapshot(this.state.tick, m.ack, meOf(m.player, this.me), shared));
    this.ticks.record(nowMs, this.clock() - t0);
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
  }
}
