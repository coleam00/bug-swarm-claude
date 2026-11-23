// The socket handlers with a fake socket, for what real sockets can't hit on purpose: a hello that
// arrives after the server began stopping (ws.test.ts covers the stop itself over real sockets).
import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { PROTOCOL_VERSION } from "../../shared/arena/constants";
import { encodeHello } from "../../shared/arena/protocol";
import { Rooms } from "./rooms";
import { CLOSE_RESTARTING, createArenaSockets, newSocketData, type SocketData } from "./sockets";

test("a hello that arrives after restart is answered restarting and joins nothing", () => {
  const rooms = new Rooms({ startTimer: () => () => {} });
  const sockets = createArenaSockets(rooms);
  const sent: string[] = [];
  const closes: number[] = [];
  const ws = {
    data: newSocketData(),
    send: (m: string) => void sent.push(m),
    close: (code: number) => void closes.push(code),
    ping: () => {},
    terminate: () => {},
  } as unknown as ServerWebSocket<SocketData>;
  sockets.open!(ws);
  sockets.restart();
  expect(sockets.openCount).toBe(1);
  sockets.message!(ws, encodeHello(PROTOCOL_VERSION, "Late", "tabs", "d".repeat(32), false));
  expect(sent).toEqual(Array(2).fill(JSON.stringify({ t: "error", code: "restarting" })));
  expect(closes).toEqual([CLOSE_RESTARTING, CLOSE_RESTARTING]);
  expect(rooms.stats().arenas).toEqual([]);
  sockets.close!(ws, 1012, "");
  expect(sockets.openCount).toBe(0);
});

test("a send buffer over the bound drops the socket only after slowMs straight; draining below it starts the wait again (#104)", async () => {
  const rooms = new Rooms({ startTimer: () => () => {} });
  let t = 0;
  const sockets = createArenaSockets(rooms, { now: () => t, liveness: { pingMs: 5, silentMs: 1e9, slowBytes: 100, slowMs: 1000 } });
  let buffered = 0;
  let terminated = false;
  const ws = {
    data: newSocketData("203.0.113.7"),
    send: () => 1,
    close: () => {},
    ping: () => {},
    terminate: () => void (terminated = true),
    getBufferedAmount: () => buffered,
  } as unknown as ServerWebSocket<SocketData>;
  sockets.open!(ws);
  // Lets the ping timer run a few times at clock `at`.
  const at = async (ms: number) => {
    t = ms;
    ws.data.lastHeard = ms;
    await Bun.sleep(30);
  };
  buffered = 101;
  await at(0);
  await at(900);
  buffered = 100; // drained to the bound: not slow
  await at(950);
  buffered = 101;
  await at(1500);
  expect(terminated).toBe(false); // 1500 ms over the bound in all, but only 550 ms since it drained
  await at(1950);
  expect(terminated).toBe(false);
  await at(2500);
  expect(terminated).toBe(true);
  sockets.close!(ws, 1006, "");
});
