// How the stream board keeps itself current: one GET /api/board every 2 s, never two at once,
// backing off while the API is down and keeping the last good board on screen. Timers and the
// request are injected, so `bun test` covers it with no browser and no real time. No DOM access
// here: `scripts/load.ts` imports the cadence from this file.
import { parseBoard, type Board } from "./data";

/** A load every 2 s once the last one settles, each cut at 2.5 s: while the API answers, a refresh lands at least every 4.5 s. */
export const BOARD_POLL_MS = 2000;
export const BOARD_TIMEOUT_MS = 2500;
export const BOARD_MAX_BACKOFF_MS = 10_000;

export type BoardStatus = "live" | "reconnecting";

/** The wait before the next load, after this many failures in a row. */
export function nextDelay(failures: number): number {
  if (failures <= 1) return BOARD_POLL_MS;
  return Math.min(BOARD_MAX_BACKOFF_MS, BOARD_POLL_MS * 2 ** (failures - 1));
}

/** One read of /api/board, on the page's own origin. Every failure is logged and comes back as "failed". */
export async function fetchBoard(fetchFn: typeof fetch = fetch): Promise<Board | "failed"> {
  try {
    const res = await fetchFn("/api/board", { signal: AbortSignal.timeout(BOARD_TIMEOUT_MS) });
    if (!res.ok) {
      console.error(`board failed: HTTP ${res.status}`);
      return "failed";
    }
    const board = parseBoard(await res.json());
    if (board) return board;
    console.error("board failed: the response was not a board");
  } catch (err) {
    console.error("board failed", err);
  }
  return "failed";
}

export type PollerDeps = {
  load: () => Promise<Board | "failed">;
  onData: (board: Board) => void;
  onStatus: (status: BoardStatus) => void;
  setTimer: (fn: () => void, ms: number) => void;
};

/**
 * Loads at once, then again once each load has settled. A failure (a "failed" load, a
 * rejected one, or onData throwing) leaves the last board alone, counts toward the backoff and
 * shows "reconnecting"; the next success resets both. onStatus fires only on a change.
 */
export function startPolling(deps: PollerDeps): void {
  let failures = 0;
  let status: BoardStatus | null = null;

  const setStatus = (s: BoardStatus) => {
    if (s === status) return;
    status = s;
    deps.onStatus(s);
  };

  const tick = async () => {
    let ok = false;
    try {
      const result = await deps.load();
      if (result !== "failed") {
        deps.onData(result);
        ok = true;
      }
    } catch (err) {
      console.error("board update failed", err);
    }
    failures = ok ? 0 : failures + 1;
    setStatus(ok ? "live" : "reconnecting");
    deps.setTimer(() => void tick(), nextDelay(failures));
  };

  void tick();
}
