// Who a /ws connection comes from, and the environment switches for the arena's limits (#104).
// pickClientIp and proxyHops are release 1's (its HTTP run-start limit, #27 / PR #30), revived for
// the per-address /ws limits: behind Railway the socket address is Railway's proxy, so the client
// comes from headers (architecture.md, "Client address behind a proxy").
import { isIP } from "node:net";

/** The env var that says how many proxies in front of the server append to X-Forwarded-For. */
export const PROXY_HOPS_VAR = "TRUST_PROXY_HOPS";
/** No deployment sits behind more proxies than this; a bigger value is a typo. */
export const MAX_PROXY_HOPS = 10;
/** The env var that turns the per-address /ws limits off, for `bun run bots` and the playtest only. Never set on Railway. */
export const ALLOW_LOAD_VAR = "BUG_SWARM_ALLOW_LOAD";

/**
 * The client's address, for the per-address limits. Never throws: anything unexpected is the peer.
 *
 * `hops` 0 (the default): X-Real-IP, which Railway documents as the client's address
 * (docs.railway.com, networking specs and limits), else the rightmost X-Forwarded-For entry
 * (the hop the last proxy appended), else the peer.
 *
 * `hops` n >= 1 (TRUST_PROXY_HOPS): the n-th X-Forwarded-For entry from the right, when it is
 * an IP address; else the peer. Each of the n trusted proxies appends one entry, so entries a
 * client prepends sit to the left of the chosen one and can never be picked.
 */
export function pickClientIp(header: (name: string) => string | undefined, peer: () => string, hops: number): string {
  try {
    if (hops === 0) {
      const real = header("x-real-ip")?.trim();
      if (real) return real;
      const last = header("x-forwarded-for")?.split(",").pop()?.trim();
      return last || peer();
    }
    const entries = (header("x-forwarded-for") ?? "").split(",").map((e) => e.trim());
    const chosen = entries[entries.length - hops];
    return chosen && isIP(chosen) !== 0 ? chosen : peer();
  } catch {
    return peer();
  }
}

/**
 * How many trusted proxies append to X-Forwarded-For. Unset or empty: 0. A whole number up to
 * MAX_PROXY_HOPS: that. Anything else throws, so the server refuses to start rather than count
 * every viewer as one client.
 */
export function proxyHops(env: Record<string, string | undefined>): number {
  const raw = env[PROXY_HOPS_VAR];
  if (raw === undefined || raw === "") return 0;
  if (!/^(0|[1-9]\d*)$/.test(raw) || Number(raw) > MAX_PROXY_HOPS) {
    throw new Error(`${PROXY_HOPS_VAR} must be a whole number from 0 to ${MAX_PROXY_HOPS} (got "${raw}")`);
  }
  return Number(raw);
}

/**
 * Whether the per-address /ws limits are off (load testing only). Unset, empty or "0": no, the
 * limits apply. "1": yes. Anything else throws, so the server refuses to start rather than guess.
 */
export function allowLoad(env: Record<string, string | undefined>): boolean {
  const raw = env[ALLOW_LOAD_VAR];
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${ALLOW_LOAD_VAR} must be 1 (load testing only) or unset (got "${raw}")`);
}
