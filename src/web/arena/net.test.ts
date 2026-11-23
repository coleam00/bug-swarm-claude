import { expect, test } from "bun:test";
import { ERROR_CODES } from "../../shared/arena/protocol";
import { SERVER_SILENT_MS, connectArena, isFinalError, reconnectDelay, refusalStatus, serverSilent, socketUrl } from "./net";

test("rejoin waits 0.5 s, doubling to 5 s", () => {
  expect([0, 1, 2, 3, 4, 5, 50].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000]);
});

test("a refused name, team or version never retries; a hello timeout does", () => {
  expect(ERROR_CODES.filter(isFinalError)).toEqual(["version", "name", "team"]);
});

test("the socket follows the page's scheme and host", () => {
  expect(socketUrl({ protocol: "https:", host: "bugs.example:8443" })).toBe("wss://bugs.example:8443/ws");
  expect(socketUrl({ protocol: "http:", host: "127.0.0.1:5173" })).toBe("ws://127.0.0.1:5173/ws");
});

test("a connection silent for over 5 s is given up on (the server sends 20 snapshots a second)", () => {
  expect(serverSilent(1000, 1000 + SERVER_SILENT_MS)).toBe(false);
  expect(serverSilent(1000, 1001 + SERVER_SILENT_MS)).toBe(true);
});

test("the server's limits (#104) read as a short message, and are never final", () => {
  expect(refusalStatus("limit")).toBe("Too many connections from your network. Trying again...");
  expect(refusalStatus("busy")).toBe("Arenas are full. Trying again in a moment...");
  expect(ERROR_CODES.filter((c) => refusalStatus(c) !== null)).toEqual(["limit", "busy"]);
  expect(isFinalError("limit") || isFinalError("busy")).toBe(false);
});

test("a limit refusal stays on screen through the server's close, and the page retries", async () => {
  // A real server on an ephemeral port that refuses every hello as /ws does past its limits.
  let hellos = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 426 })),
    websocket: {
      message(ws) {
        hellos++;
        ws.send(JSON.stringify({ t: "error", code: "limit" }));
        ws.close(1008, "limit");
      },
    },
  });
  const statuses: (string | null)[] = [];
  const conn = connectArena(
    { name: "Ada", team: "tabs", player: "0".repeat(32), touch: () => false },
    { message: () => {}, status: (s) => statuses.push(s), refused: () => {}, newBuild: () => {} },
    `ws://127.0.0.1:${server.port}/ws`,
  );
  try {
    const deadline = Date.now() + 5000;
    while (hellos < 2 && Date.now() < deadline) await Bun.sleep(10);
    expect(hellos).toBe(2); // retried after the first refusal (0.5 s)
    const limit = refusalStatus("limit");
    expect(statuses[0]).toBe("Connecting...");
    expect(statuses.slice(1).every((s) => s === limit)).toBe(true);
    expect(statuses).not.toContain("Reconnecting...");
  } finally {
    conn.close();
    await server.stop(true);
  }
});
