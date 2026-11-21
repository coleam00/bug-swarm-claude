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
