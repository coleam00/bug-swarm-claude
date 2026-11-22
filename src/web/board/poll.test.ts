import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Board } from "./data";
import { BOARD_POLL_MS, fetchBoard, startPolling, type BoardStatus } from "./poll";

const BOARD: Board = { top: [{ name: "Ann", score: 50 }], teams: { tabs: 50, spaces: 0 }, playing: 1, arenas: [{ id: 1, players: 1, wave: 2, queen: null }] };

let errors: ReturnType<typeof spyOn>;
beforeEach(() => {
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
});

/** A poller over a fake timer queue and loads that the test settles by hand. */
function harness(opts: { onData?: (b: Board) => void } = {}) {
  const loads: { resolve: (v: Board | "failed") => void; reject: (e: Error) => void }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const data: Board[] = [];
  const statuses: BoardStatus[] = [];
  const start = () =>
    startPolling({
      load: () => new Promise((resolve, reject) => loads.push({ resolve, reject })),
      onData: opts.onData ?? ((b) => data.push(b)),
      onStatus: (s) => statuses.push(s),
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
      },
    });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  /** Settles the latest load, lets the poller react, and returns the delay it scheduled. */
  const settle = async (v: Board | "failed" | Error) => {
    const l = loads.at(-1)!;
    if (v instanceof Error) l.reject(v);
    else l.resolve(v);
    await flush();
    return timers.at(-1)?.ms;
  };
  /** Fires the latest timer, which starts the next load. */
  const fire = () => timers.at(-1)!.fn();
  return { start, loads, timers, data, statuses, settle, fire, flush };
}

describe("startPolling", () => {
  test("loads at once, and never again until that load has settled", async () => {
    const h = harness();
    h.start();
    expect(h.loads.length).toBe(1);
    await h.flush();
    expect(h.timers.length).toBe(0); // nothing scheduled while the load is in flight
    expect(await h.settle(BOARD)).toBe(BOARD_POLL_MS);
    expect(h.loads.length).toBe(1);
    h.fire();
    expect(h.loads.length).toBe(2);
  });

  test("backs off over failures, keeps the last board, and resets on success", async () => {
    const h = harness();
    h.start();
    const delays: (number | undefined)[] = [await h.settle(BOARD)];
    for (let i = 0; i < 5; i++) {
      h.fire();
      delays.push(await h.settle("failed"));
    }
    h.fire();
    delays.push(await h.settle(BOARD));
    expect(delays).toEqual([2000, 2000, 4000, 8000, 10000, 10000, 2000]);
    expect(h.data).toEqual([BOARD, BOARD]); // never called on a failure
    expect(h.statuses).toEqual(["live", "reconnecting", "live"]);
  });

  test("a rejected load or an onData that throws counts as a failure, and polling carries on", async () => {
    let calls = 0;
    const h = harness({
      onData: () => {
        calls++;
        throw new Error("render broke");
      },
    });
    h.start();
    expect(await h.settle(new Error("network"))).toBe(2000);
    h.fire();
    expect(await h.settle(BOARD)).toBe(4000);
    expect(calls).toBe(1);
    expect(h.statuses).toEqual(["reconnecting"]);
    expect(errors).toHaveBeenCalled();
  });
});

describe("fetchBoard", () => {
  const respond = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("asks the page's own origin for /api/board and returns the board", async () => {
    let url = "";
    let signal: AbortSignal | null | undefined;
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = u;
      signal = init?.signal;
      return new Response(JSON.stringify(BOARD));
    }) as unknown as typeof fetch;
    expect(await fetchBoard(fetchFn)).toEqual(BOARD);
    expect(url).toBe("/api/board");
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("a 500, a body that isn't a board, bad JSON, or a rejected fetch is a logged failure", async () => {
    const cases: (typeof fetch)[] = [
      respond(500, { error: "x" }),
      respond(200, { top: "nope" }),
      (async () => new Response("not json")) as unknown as typeof fetch,
      (async () => {
        throw new TypeError("offline");
      }) as unknown as typeof fetch,
    ];
    for (const fetchFn of cases) expect(await fetchBoard(fetchFn)).toBe("failed");
    expect(errors).toHaveBeenCalledTimes(cases.length);
  });
});
