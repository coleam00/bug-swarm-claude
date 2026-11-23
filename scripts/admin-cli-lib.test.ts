import { describe, expect, test } from "bun:test";
import { adminCommand } from "./admin-cli-lib";
import type { CommandResult } from "./admin-lib";

const TOKEN = "s3cret-token-of-32-characters-xx";
const ENV = { ADMIN_TOKEN: TOKEN };
const BASE = "https://bugs.example.app";

type Sent = { url: string; method?: string; body?: string; auth?: string | null; type?: string | null };

/** A fetch that records each request and answers with `status` and `body`. */
function fakeFetch(status = 200, body: unknown = { lines: ["ok"] }) {
  const sent: Sent[] = [];
  const fn = async (url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    sent.push({ url, method: init.method, body: init.body as string | undefined, auth: h.get("authorization"), type: h.get("content-type") });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { sent, fn };
}

/** No line of any result may carry the token. */
function noToken(r: CommandResult) {
  for (const line of [...r.out, ...r.err]) expect(line).not.toContain(TOKEN);
}

async function run(argv: string[], f = fakeFetch(), env: Record<string, string | undefined> = ENV) {
  const r = await adminCommand(argv, env, f.fn);
  noToken(r);
  return { r, sent: f.sent };
}

describe("requests", () => {
  test("stats: GET with the Bearer token, the range normalized to UTC", async () => {
    const { r, sent } = await run(["--", "--url", `${BASE}/`, "stats", "--since", "2026-11-28T09:00:00-06:00", "--until=2026-11-28T10:15:00-06:00"]);
    expect(r).toEqual({ code: 0, out: ["ok"], err: [] });
    expect(sent).toEqual([
      {
        url: `${BASE}/api/admin/stats?since=2026-11-28T15%3A00%3A00.000Z&until=2026-11-28T16%3A15%3A00.000Z`,
        method: "GET",
        body: undefined,
        auth: `Bearer ${TOKEN}`,
        type: null,
      },
    ]);
    expect((await run(["--url", BASE, "stats"])).sent[0]!.url).toBe(`${BASE}/api/admin/stats`);
  });

  test("hide: POST the whole name as JSON", async () => {
    const { r, sent } = await run(["--url", BASE, "hide", "Bad", "Name"]);
    expect(r.code).toBe(0);
    expect(sent).toEqual([{ url: `${BASE}/api/admin/hide`, method: "POST", body: '{"name":"Bad Name"}', auth: `Bearer ${TOKEN}`, type: "application/json" }]);
  });

  test("reset --yes: POST the confirm", async () => {
    const { r, sent } = await run(["--url", BASE, "reset", "--yes"]);
    expect(r.code).toBe(0);
    expect(sent).toEqual([{ url: `${BASE}/api/admin/reset`, method: "POST", body: '{"confirm":true}', auth: `Bearer ${TOKEN}`, type: "application/json" }]);
  });
});

test("any link to the service reaches its admin routes: the path and query are dropped", async () => {
  for (const url of [`${BASE}/board`, `${BASE}/board/?x=1`, `${BASE}/?x=1`]) {
    const { r, sent } = await run(["--url", url, "hide", "n"]);
    expect(r.code).toBe(0);
    expect(sent.map((s) => s.url)).toEqual([`${BASE}/api/admin/hide`]);
  }
});

describe("refusals that send nothing", () => {
  test("reset without --yes", async () => {
    for (const argv of [["--url", BASE, "reset"], ["--url", BASE, "reset", "--no"]]) {
      const { r, sent } = await run(argv);
      expect(r).toEqual({ code: 1, out: [], err: [`admin reset: deletes every run and player on ${BASE}; run again with --yes`] });
      expect(sent).toEqual([]);
    }
  });

  test("no token in the environment", async () => {
    for (const env of [{}, { ADMIN_TOKEN: "  " }]) {
      const { r, sent } = await run(["--url", BASE, "stats"], fakeFetch(), env);
      expect(r).toEqual({ code: 1, out: [], err: ["admin: set ADMIN_TOKEN in your environment (the same value as on the service)"] });
      expect(sent).toEqual([]);
    }
  });

  test("plain http to anything but localhost", async () => {
    const remote = await run(["--url", "http://bugs.example.app", "stats"]);
    expect(remote.r.err[0]).toBe("admin: refusing to send the token over plain http to bugs.example.app (use https://)");
    expect(remote.sent).toEqual([]);
    for (const local of ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
      const { r, sent } = await run(["--url", local, "stats"]);
      expect(r.code).toBe(0);
      expect(sent).toHaveLength(1);
    }
  });

  test("usage errors: no --url, no command, an unknown command, a bad time, no name", async () => {
    for (const argv of [["stats"], ["--url", BASE], ["--url", BASE, "wipe"], ["--url", BASE, "stats", "--since", "yesterday"], ["--url", BASE, "hide"], ["--url", "nope", "stats"]]) {
      const { r, sent } = await run(argv);
      expect(r.code).toBe(1);
      expect(r.err.length).toBeGreaterThan(0);
      expect(sent).toEqual([]);
    }
  });
});

describe("answers", () => {
  test("a non-200 answer is exit 1 with no output", async () => {
    const { r } = await run(["--url", BASE, "stats"], fakeFetch(401, "unauthorized"));
    expect(r.code).toBe(1);
    expect(r.out).toEqual([]);
  });

  test("a 400 relays the server's error", async () => {
    const { r } = await run(["--url", BASE, "stats"], fakeFetch(400, { error: 'reset needs {"confirm": true}' }));
    expect(r).toEqual({ code: 1, out: [], err: ['admin: reset needs {"confirm": true}'] });
  });

  test("200 prints the server's lines", async () => {
    const { r } = await run(["--url", BASE, "stats"], fakeFetch(200, { lines: ["players: 2", "finished_runs: 3"] }));
    expect(r).toEqual({ code: 0, out: ["players: 2", "finished_runs: 3"], err: [] });
  });

  test("a fetch that throws, even with the token in its message, never prints the token", async () => {
    const throwing = {
      sent: [],
      fn: async (): Promise<Response> => {
        throw new Error(`connect failed (Authorization: Bearer ${TOKEN})`);
      },
    };
    const { r } = await run(["--url", BASE, "stats"], throwing);
    expect(r).toEqual({ code: 1, out: [], err: [`admin: could not reach ${BASE}: connect failed (Authorization: Bearer ***)`] });
  });
});
