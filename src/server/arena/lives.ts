// Saving finished arena lives (#55). A life is a run (PRD.md, "The bet"), except a 0-point life
// that ended within its first 5 s, which is never saved (countsAsLife, #114). The server writes it
// through db.ts as a run_started and a run_ended, so the top 10, best, team totals, /board and
// `bun run stats` count it with no change. Lives end inside the tick, which must never wait on the
// database (engineering.md, "Server budget"), so `save` only queues; the queue is written on the
// next turn of the event loop. A failed write is logged with its run id and play carries on.
import type { Database } from "bun:sqlite";
import { findPlayer, recordRunEnded, recordRunStarted, upsertPlayer } from "../db";
import type { LifeRecord } from "./room";

/** A life shorter than this, with 0 points, is not a life (#114). */
export const MIN_LIFE_S = 5;

/**
 * Whether a finished life counts as a run. A life with 0 points that ended within its first 5 s
 * (a refresh, a dropped connection, a redeploy in its first seconds) is not a life: it is never
 * saved, so it is in no stats, top 10 or team total (#114, owner ruling). Anything with points counts.
 */
export function countsAsLife(score: number, seconds: number): boolean {
  return score > 0 || seconds >= MIN_LIFE_S;
}

export type LifeSaver = {
  /** Queues a finished life, or drops it when it is not one (countsAsLife). Never throws, never touches the database. */
  save(r: LifeRecord): void;
  /** Writes everything queued now (the server calls it when it stops). */
  flush(): void;
};

/** Writes one life as a run, in one transaction. The team stored for the player wins over the hello's. */
export function writeLife(db: Database, runId: string, r: LifeRecord): void {
  const end = new Date(r.endedAtMs);
  const start = new Date(r.endedAtMs - Math.round(r.seconds * 1000));
  db.transaction(() => {
    // A player's team is stored once and never switched (architecture.md, "Data").
    const team = findPlayer(db, r.playerKey)?.team ?? r.team;
    upsertPlayer(db, r.playerKey, r.name, team, start);
    recordRunStarted(db, runId, r.playerKey, start, team);
    recordRunEnded(
      db,
      { runId, playerId: r.playerKey, score: r.score, squashes: r.kills, seconds: r.seconds, touch: r.touch, upgrades: [], team },
      end,
    );
  })();
}

export function createLifeSaver(
  db: Database,
  opts: { log?: (line: string, err: unknown) => void; newId?: () => string; defer?: (fn: () => void) => void } = {},
): LifeSaver {
  const log = opts.log ?? ((line, err) => console.error(line, err));
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const defer = opts.defer ?? ((fn) => void setTimeout(fn, 0));
  const queue: LifeRecord[] = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    while (queue.length > 0) {
      const r = queue.shift()!;
      const runId = newId();
      try {
        writeLife(db, runId, r);
      } catch (err) {
        log(`arena life ${runId}: save failed`, err);
      }
    }
  };

  return {
    save(r) {
      if (!countsAsLife(r.score, r.seconds)) return;
      queue.push(r);
      if (!scheduled) {
        scheduled = true;
        defer(flush);
      }
    },
    flush,
  };
}
