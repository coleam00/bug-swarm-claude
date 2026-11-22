// RunningServer.stop with WebSocket clients that never close their side, against the real server on
// an ephemeral port, in-process (no spawned processes: #41).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import { LISTENER_STOP_WAIT_MS, SOCKET_CLOSE_WAIT_MS, startServer, type RunningServer } from "./serve";

let dir: string;
let db: Database;
let srv: RunningServer | null;
let clients: Socket[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stop-test-"));
  db = openDb(join(dir, "app.db"));
  srv = null;
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.destroy();
  // Bounded: without the fix this stop never settles, and the test, not the hook, should report it.
  if (srv) await Promise.race([srv.stop(), Bun.sleep(3000)]);
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

/** A raw WebSocket client: it upgrades /ws by hand, ignores every frame and never answers a close. */
function deafClient(port: number): Socket {
  const s = connect(port, "127.0.0.1", () => {
    s.write(
      "GET /ws HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n\r\n",
    );
  });
  s.on("data", () => {});
  s.on("error", () => {});
  return s;
}

test("stop resolves within 2 s with open WebSockets that never close, even if the listener stop never settles (#99)", async () => {
  expect(SOCKET_CLOSE_WAIT_MS + LISTENER_STOP_WAIT_MS).toBeLessThan(2000);
  const running = startServer({ port: 0, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId: "b" });
  srv = running;
  const port = running.server.port!;
  for (let i = 0; i < 4; i++) clients.push(deafClient(port));
  const deadline = performance.now() + 5000;
  while (running.server.pendingWebSockets < 4) {
    if (performance.now() > deadline) throw new Error(`only ${running.server.pendingWebSockets} of 4 sockets opened`);
    await Bun.sleep(10);
  }

  // What the failing Windows runs showed: Bun's listener stop never settled. The real stop still
  // runs (so the port is released), only its promise is held open.
  const real = running.server.stop.bind(running.server);
  (running.server as { stop: (closeActive?: boolean) => Promise<void> }).stop = (closeActive) => {
    void real(closeActive);
    return new Promise<void>(() => {});
  };

  const t0 = performance.now();
  const r = await Promise.race([running.stop(), Bun.sleep(2000).then(() => "timeout" as const)]);
  const ms = performance.now() - t0;
  expect(r).toBe(0); // nobody said hello, so no life was in progress
  expect(ms).toBeLessThan(2000);
});
