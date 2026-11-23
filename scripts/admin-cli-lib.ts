// The body of `bun run admin` (#110): stats, hide and reset against a running server's
// /api/admin/* routes (src/server/admin.ts), so the owner can run them on Railway. A function
// that returns its exit code and lines, with fetch passed in, so `bun test` runs it in-process.
// The token comes only from the environment and never appears in any line it returns.
import { ADMIN_PREFIX, MIN_TOKEN_LENGTH } from "../src/server/admin";
import { ArgError, parseStatsArgs, type CommandResult } from "./admin-lib";

export const ADMIN_USAGE =
  'usage: bun run admin -- --url <base> stats [--since <ISO time>] [--until <ISO time>] | hide "<name>" | reset --yes';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const fail = (...err: string[]): CommandResult => ({ code: 1, out: [], err });

export async function adminCommand(argv: string[], env: Record<string, string | undefined>, fetchFn: Fetch): Promise<CommandResult> {
  const args = argv.filter((a) => a !== "--");
  let url: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--url") url = args[++i];
    else if (a.startsWith("--url=")) url = a.slice("--url=".length);
    else rest.push(a);
  }
  if (!url) return fail("admin: --url <base> is required", ADMIN_USAGE);
  const [command, ...params] = rest;

  // Work out the request before anything is sent.
  let path: string;
  let init: RequestInit;
  if (command === "stats") {
    let range: { since?: string; until?: string };
    try {
      range = parseStatsArgs(params);
    } catch (e) {
      if (!(e instanceof ArgError)) throw e;
      return fail(`admin stats: ${e.message}`, ADMIN_USAGE);
    }
    const query = new URLSearchParams(range as Record<string, string>).toString();
    path = `${ADMIN_PREFIX}/stats${query ? `?${query}` : ""}`;
    init = { method: "GET" };
  } else if (command === "hide") {
    const name = params.join(" ").trim();
    if (!name) return fail("admin hide: needs a name", ADMIN_USAGE);
    path = `${ADMIN_PREFIX}/hide`;
    init = { method: "POST", body: JSON.stringify({ name }) };
  } else if (command === "reset") {
    if (params.length !== 1 || params[0] !== "--yes") {
      return fail(`admin reset: deletes every run and player on ${url}; run again with --yes`);
    }
    path = `${ADMIN_PREFIX}/reset`;
    init = { method: "POST", body: JSON.stringify({ confirm: true }) };
  } else {
    return fail(command ? `admin: unknown command: ${command}` : "admin: needs a command", ADMIN_USAGE);
  }

  let base: URL;
  try {
    base = new URL(url);
  } catch {
    return fail(`admin: not a URL: ${url}`);
  }
  if (base.protocol !== "https:" && !(base.protocol === "http:" && LOCAL_HOSTS.has(base.hostname))) {
    return fail(`admin: refusing to send the token over plain http to ${base.host} (use https://)`);
  }
  const origin = base.toString().replace(/\/+$/, "");

  const token = env.ADMIN_TOKEN?.trim() ?? "";
  if (!token) return fail("admin: set ADMIN_TOKEN in your environment (the same value as on the service)");
  const redact = (s: string) => s.replaceAll(token, "***");

  let res: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    res = await fetchFn(origin + path, { ...init, headers });
  } catch (e) {
    return fail(redact(`admin: could not reach ${origin}: ${e instanceof Error ? e.message : String(e)}`));
  }

  switch (res.status) {
    case 200: {
      const body = (await res.json().catch(() => null)) as { lines?: unknown } | null;
      const lines = Array.isArray(body?.lines) ? body.lines.filter((l): l is string => typeof l === "string") : null;
      if (!lines) return fail("admin: the server's answer had no lines");
      return { code: 0, out: lines.map(redact), err: [] };
    }
    case 404:
      return fail(`admin: admin routes are off on ${origin} (set ADMIN_TOKEN on the service, at least ${MIN_TOKEN_LENGTH} characters)`);
    case 401:
      return fail("admin: wrong ADMIN_TOKEN");
    case 429:
      return fail("admin: rate-limited: wait a minute");
    case 400: {
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
      return fail(redact(`admin: ${typeof body?.error === "string" ? body.error : "bad request"}`));
    }
    default:
      return fail(`admin: unexpected status ${res.status}`);
  }
}
