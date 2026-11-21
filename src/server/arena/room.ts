// One arena on the server: the authoritative simulation, its members' input queues, and the tick
// that steps it and sends every member a snapshot. No timers and no clock of its own: rooms.ts
// drives `advance` from its timer, so tests step it by hand.
import { INPUT_BUFFER, INPUT_STALE_TICKS, TICK_MS } from "../../shared/arena/constants";
import { EVENT, JOIN, LEAVE, encodeSnapshot, encodeSnapshotPlayers, type ArenaEvent, type RosterEntry } from "../../shared/arena/protocol";
import { clampInput, createArena, joinPlayer, leavePlayer, stepArena, type ArenaState, type Input, type Player } from "../../shared/arena/sim";
import type { Team } from "../rules";
import type { TickLog } from "./ticks";

/** Sends one text frame to a member's socket. */
export type Send = (message: string) => void;

type Member = {
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

export class Room {
  readonly state: ArenaState;
  private readonly members = new Map<number, Member>();
  private nextTickAt: number;

  constructor(
    readonly id: number,
    seed: number,
    startMs: number,
    private readonly ticks: TickLog,
    private readonly clock: () => number = () => performance.now(),
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
  add(name: string, team: Team, send: Send): Player {
    const player = joinPlayer(this.state, name, team);
    this.broadcast({ t: EVENT, kind: JOIN, id: player.id, name, team });
    this.members.set(player.id, { player, send, queue: [], ack: 0, lastSeq: 0 });
    return player;
  }

  /** Removes a member and tells everyone left. */
  remove(id: number): void {
    if (!this.members.delete(id)) return;
    leavePlayer(this.state, id);
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
   * while the queue is empty, its move zeroed once INPUT_STALE_TICKS pass with nothing new),
   * the arena steps, and every member gets a snapshot with its own ack. The players part of the
   * snapshot is encoded once for everyone.
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
      }
      // A dash is one press, never repeated by a held input (dash does nothing yet).
      if (!next) p.input.dash = false;
    }
    stepArena(this.state);
    const shared = encodeSnapshotPlayers(this.state.players);
    for (const m of this.members.values()) m.send(encodeSnapshot(this.state.tick, m.ack, shared));
    this.ticks.record(nowMs, this.clock() - t0);
  }

  private broadcast(event: ArenaEvent): void {
    const msg = JSON.stringify(event);
    for (const m of this.members.values()) m.send(msg);
  }
}
