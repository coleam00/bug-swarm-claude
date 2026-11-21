// The shutdown a SIGTERM or SIGINT runs (main.ts), with fakes for the server, database, timer and exit.
import { expect, test } from "bun:test";
import { buildIdFrom, gracefulShutdown, type ShutdownDeps } from "./serve";

function fakes(stop: () => Promise<number>) {
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const deps: ShutdownDeps = {
    stop: () => {
      calls.push("stop");
      return stop();
    },
    closeDb: () => void calls.push("closeDb"),
    exit: (code) => void calls.push(`exit ${code}`),
    log: (line) => void calls.push(line),
    budgetMs: 4500,
    setTimer: (fn, ms) => void timers.push({ fn, ms }),
  };
  return { calls, timers, deps };
}

test("a signal stops the server (saving its lives), closes the database, then exits 0", async () => {
  const { calls, timers, deps } = fakes(async () => 3);
  await gracefulShutdown(deps)("SIGTERM");
  expect(calls).toEqual(["stop", "closeDb", "shutdown (SIGTERM): 3 lives saved", "exit 0"]);
  expect(timers.map((t) => t.ms)).toEqual([4500]);
});

test("a stop that never finishes still exits by the budget", async () => {
  const { calls, timers, deps } = fakes(() => new Promise<number>(() => {}));
  void gracefulShutdown(deps)("SIGINT");
  await Bun.sleep(0);
  expect(calls).toEqual(["stop"]);
  timers[0]!.fn();
  expect(calls.at(-1)).toBe("exit 1");
});

test("a second signal while stopping does nothing", async () => {
  const { calls, timers, deps } = fakes(async () => 1);
  const shutdown = gracefulShutdown(deps);
  await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
  expect(calls).toEqual(["stop", "closeDb", "shutdown (SIGTERM): 1 life saved", "exit 0"]);
  expect(timers.length).toBe(1);
});

test("a failed stop is logged and exits 1", async () => {
  const { calls, deps } = fakes(async () => {
    throw new Error("boom");
  });
  await gracefulShutdown(deps)("SIGTERM");
  expect(calls).toEqual(["stop", "shutdown (SIGTERM): failed: Error: boom", "exit 1"]);
});

test("the build id is Railway's commit, else BUILD_ID, else the start time", () => {
  expect(buildIdFrom({ RAILWAY_GIT_COMMIT_SHA: "abc", BUILD_ID: "two" }, 7)).toBe("abc");
  expect(buildIdFrom({ BUILD_ID: "two" }, 7)).toBe("two");
  expect(buildIdFrom({}, 7)).toBe("7");
});
