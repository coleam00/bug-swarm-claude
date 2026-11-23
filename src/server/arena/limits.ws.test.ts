// Stream safety (#104) over real sockets: the per-address socket and join limits, the client
// address behind a proxy, the people cap and the slow-reader drop, against the real server
// (startServer) on an ephemeral port, closed before each test ends. The clients are raw TCP
// sockets that upgrade /ws by hand, so each sets its own X-Forwarded-For / X-Real-IP headers, never
// answers the server's close handshake, and can stop reading.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as tcpConnect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { JOINS_PER_ADDRESS_PER_MINUTE, MAX_SOCKETS_PER_ADDRESS, PROTOCOL_VERSION } from "../../shared/arena/constants";
import { encodeHello, encodeInput } from "../../shared/arena/protocol";
import { computeStats, openDb } from "../db";
import { startServer, type RunningServer, type ServerOptions } from "../serve";

const TIMEOUT = 30_000;
const LIVENESS = { pingMs: 100, silentMs: 60_000 };

let dir: string;
let db: Database;
let srv: RunningServer;
let clients: Raw[];
let port: number;

const serve = (extra: Partial<ServerOptions> = {}) => {
  srv = startServer({ port: 0, hostname: "127.0.0.1", db, distDir: join(dir, "no-dist"), buildId: "test", liveness: LIVENESS, arenaFill: 0, ...extra });
  port = srv.server.port!;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "arena-limits-test-"));
  db = openDb(join(dir, "app.db"));
  clients = [];
});

afterEach(async () => {
  for (const c of clients) c.destroy();
  await srv.stop();
  db.close(); // close before deleting: Windows refuses to delete an open file
  rmSync(dir, { recursive: true, force: true });
});

type Raw = {
  /** The text frames the server sent, parsed. */
  got: { t: string; code?: string }[];
  /** True once the server sent a close frame. */
  closeFrame: () => boolean;
  /** True once the TCP connection ended. */
  ended: () => boolean;
  /** Resolves once the server answered the upgrade. */
  upgraded: Promise<void>;
  /** Sends one masked text frame. */
  send: (text: string) => void;
  /** Sends `n` masked ping frames of 125 bytes each. */
  pings: (n: number) => void;
  /** Stops reading: the kernel buffers fill, then the server's send buffer. */
  pause: () => void;
  destroy: () => void;
};

/** A masked client frame (RFC 6455 section 5.2) with `opcode` and `payload` (under 64 KiB). */
function frame(opcode: number, payload: Uint8Array): Buffer {
  const mask = [0x12, 0x34, 0x56, 0x78];
  const n = payload.length;
  const head = n < 126 ? [0x80 | opcode, 0x80 | n] : [0x80 | opcode, 0x80 | 126, n >> 8, n & 0xff];
  const out = Buffer.alloc(head.length + 4 + n);
  out.set(head, 0);
  out.set(mask, head.length);
  for (let i = 0; i < n; i++) out[head.length + 4 + i] = payload[i]! ^ mask[i % 4]!;
  return out;
}

/** A raw /ws client with these extra request headers. */
function raw(headers: Record<string, string> = {}): Raw {
  const got: Raw["got"] = [];
  let closeFrame = false;
  let ended = false;
  let upgradedFlag = false;
  let buf = Buffer.alloc(0);
  let resolveUpgrade!: () => void;
  const upgraded = new Promise<void>((r) => (resolveUpgrade = r));
  const s: Socket = tcpConnect(port, "127.0.0.1", () => {
    const extra = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    s.write(
      "GET /ws HTTP/1.1\r\n" +
        `Host: 127.0.0.1:${port}\r\n` +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
        "Sec-WebSocket-Version: 13\r\n" +
        extra +
        "\r\n",
    );
  });
  s.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgradedFlag) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgradedFlag = true;
      buf = buf.subarray(end + 4);
      resolveUpgrade();
    }
    // Server frames are unmasked.
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0]! & 0x0f;
      let len = buf[1]! & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (buf.length < at + len) return;
      const payload = buf.subarray(at, at + len);
      buf = buf.subarray(at + len);
      if (opcode === 1) got.push(JSON.parse(payload.toString("utf8")));
      if (opcode === 8) closeFrame = true;
    }
  });
  s.on("close", () => (ended = true));
  s.on("error", () => {});
  const c: Raw = {
    got,
    closeFrame: () => closeFrame,
    ended: () => ended,
    upgraded,
    send: (text) => void s.write(frame(1, new TextEncoder().encode(text))),
    pings: (n) => {
      const one = frame(9, new Uint8Array(125));
      s.write(Buffer.concat(Array(n).fill(one)));
    },
    pause: () => void s.pause(),
    destroy: () => void s.destroy(),
  };
  clients.push(c);
  return c;
}

async function until(what: string, ok: () => boolean, ms = TIMEOUT - 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

let nextPlayer = 0;
const hello = (name: string) => encodeHello(PROTOCOL_VERSION, name, "tabs", (nextPlayer++).toString(16).padStart(32, "0"), false);
const welcomed = (c: Raw) => c.got.some((m) => m.t === "welcome");
const refusedWith = (c: Raw, code: string) => c.got.some((m) => m.t === "error" && m.code === code);

/** Opens a client, says hello once upgraded, and waits for its welcome or its error. */
async function enter(name: string, headers: Record<string, string> = {}): Promise<Raw> {
  const c = raw(headers);
  await c.upgraded;
  c.send(hello(name));
  await until(`${name}'s answer`, () => c.got.length > 0);
  return c;
}

test(
  "500 sockets from one address: 12 are admitted, the other 488 get `limit` and a close",
  async () => {
    serve();
    const all: Raw[] = [];
    // In batches of 50; each says hello as soon as it is upgraded, refused or not.
    for (let b = 0; b < 10; b++) {
      const batch = Array.from({ length: 50 }, () => raw());
      await Promise.all(batch.map((c) => c.upgraded));
      batch.forEach((c, i) => c.send(hello(`p${b}x${i}`)));
      all.push(...batch);
    }
    await until("every socket answered", () => all.every((c) => c.got.length > 0));
    const admitted = all.filter(welcomed);
    const refused = all.filter((c) => refusedWith(c, "limit"));
    expect(admitted.length).toBe(MAX_SOCKETS_PER_ADDRESS);
    expect(refused.length).toBe(500 - MAX_SOCKETS_PER_ADDRESS);
    // A refused socket's hello joined nothing; each got the error and then a close.
    expect(refused.every((c) => c.got.length === 1 && c.closeFrame())).toBe(true);
    expect(srv.rooms.stats().players).toBe(MAX_SOCKETS_PER_ADDRESS);
    // One admitted socket leaves: a newcomer from the same address gets its slot.
    admitted[0]!.destroy();
    await until("the slot freed", () => srv.openSockets === MAX_SOCKETS_PER_ADDRESS - 1);
    expect(welcomed(await enter("Again"))).toBe(true);
    expect(refusedWith(await enter("OneMore"), "limit")).toBe(true);
  },
  TIMEOUT,
);

test(
  "the 31st join from one address within a minute gets `limit`",
  async () => {
    serve();
    for (let i = 0; i < JOINS_PER_ADDRESS_PER_MINUTE; i++) {
      const c = await enter(`j${i}`);
      expect(welcomed(c)).toBe(true);
      c.destroy();
      await until("its close", () => srv.openSockets === 0);
    }
    const last = await enter("j30");
    expect(refusedWith(last, "limit")).toBe(true);
    expect(srv.rooms.stats().players).toBe(0);
  },
  TIMEOUT,
);

test(
  "behind one proxy hop the address the proxy appended is counted, whatever the client prepends",
  async () => {
    serve({ proxyHops: 1 });
    // Every socket here comes from 127.0.0.1; only the header tells them apart.
    for (let i = 0; i < MAX_SOCKETS_PER_ADDRESS; i++) {
      expect(welcomed(await enter(`h${i}`, { "X-Forwarded-For": `10.9.${i}.1, 203.0.113.7`, "X-Real-IP": `10.8.${i}.1` }))).toBe(true);
    }
    expect(refusedWith(await enter("spoof", { "X-Forwarded-For": "10.7.7.7, 203.0.113.7" }), "limit")).toBe(true);
    expect(welcomed(await enter("other", { "X-Forwarded-For": "10.9.0.1, 203.0.113.8" }))).toBe(true);
    // No header at all: the peer, 127.0.0.1, its own budget.
    expect(welcomed(await enter("peer"))).toBe(true);
  },
  TIMEOUT,
);

test(
  "with no hop trusted, X-Real-IP is the address counted",
  async () => {
    serve();
    for (let i = 0; i < MAX_SOCKETS_PER_ADDRESS; i++) expect(welcomed(await enter(`r${i}`, { "X-Real-IP": "198.51.100.9" }))).toBe(true);
    expect(refusedWith(await enter("r12", { "X-Real-IP": "198.51.100.9" }), "limit")).toBe(true);
    expect(welcomed(await enter("r13", { "X-Real-IP": "198.51.100.10" }))).toBe(true);
  },
  TIMEOUT,
);

test(
  "past the people cap a hello gets `busy` and opens no arena; retrying it spends no joins",
  async () => {
    serve({ maxPeople: 2, proxyHops: 1 });
    const a = await enter("Ada", { "X-Forwarded-For": "203.0.113.1" });
    await enter("Bob", { "X-Forwarded-For": "203.0.113.2" });
    expect(srv.rooms.stats().arenas.length).toBe(1);
    // More refusals than the join limit, from one address, one at a time as a retrying page would.
    for (let i = 0; i < JOINS_PER_ADDRESS_PER_MINUTE + 10; i++) {
      const c = await enter("Cy", { "X-Forwarded-For": "203.0.113.3" });
      expect(c.got).toEqual([{ t: "error", code: "busy" }]);
      await until("the close", () => c.closeFrame());
      c.destroy();
      await until("its close", () => srv.openSockets === 2);
    }
    expect(srv.rooms.stats().arenas.length).toBe(1);
    expect(srv.rooms.stats().players).toBe(2);
    a.destroy();
    await until("Ada gone", () => srv.rooms.stats().players === 1);
    expect(welcomed(await enter("Cy", { "X-Forwarded-For": "203.0.113.3" }))).toBe(true);
  },
  TIMEOUT,
);

test(
  "the load allowance (BUG_SWARM_ALLOW_LOAD=1) admits 20 sockets from one address",
  async () => {
    serve({ allowLoad: true });
    for (let i = 0; i < 20; i++) expect(welcomed(await enter(`l${i}`))).toBe(true);
    expect(srv.rooms.stats().players).toBe(20);
  },
  TIMEOUT,
);

test(
  "a socket that stops reading is dropped once its send buffer stays over the bound, and its life is saved; one that reads stays",
  async () => {
    const slowMs = 300;
    serve({ liveness: { ...LIVENESS, slowBytes: 16 * 1024, slowMs } });
    const deaf = await enter("Deaf", { "X-Real-IP": "203.0.113.20" });
    const reader = await enter("Reads", { "X-Real-IP": "203.0.113.21" });
    expect(welcomed(deaf) && welcomed(reader)).toBe(true);
    deaf.pause();
    // Both keep sending inputs (so the silent drop can't be what ends them) and flood pings, whose
    // pongs fill a send buffer nobody drains. Not a fixed byte count: loopback buffers differ by OS.
    // About 2.5 MB/s of pongs: Linux's loopback buffers absorb several MB before Bun's grows.
    const start = Date.now();
    let seq = 1;
    while (!deaf.ended() && Date.now() - start < 10_000) {
      for (const c of [deaf, reader]) {
        c.send(encodeInput({ seq, mx: 1, my: 0, aim: 0, fire: false, dash: false }));
        c.pings(400);
      }
      seq++;
      await Bun.sleep(20);
    }
    expect(deaf.ended()).toBe(true);
    expect(reader.ended()).toBe(false);
    expect(srv.rooms.stats().players).toBe(1);
    // Its life ended with the drop and was saved, as any disconnect's is.
    await until("the life saved", () => computeStats(db).finishedRuns === 1, 5000);
  },
  TIMEOUT,
);
