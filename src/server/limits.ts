import type { Context } from "hono";
import { RUN_STARTS_PER_PLAYER, RUN_STARTS_PER_WINDOW, clientIpResolver, type AppOptions } from "./app";

/** The env var that raises the run start limits, for `bun run load` only. Never set in production. */
export const START_LIMIT_VAR = "RUN_STARTS_PER_WINDOW";
/** The env var that says how many proxies in front of the server append to X-Forwarded-For. */
export const PROXY_HOPS_VAR = "TRUST_PROXY_HOPS";
/** No deployment sits behind more proxies than this; a bigger value is a typo. */
export const MAX_PROXY_HOPS = 10;

export type StartLimits = { perIp: number; perPlayer: number; raised: boolean };

/**
 * The run starts allowed per client IP and per player id per window. Unset or empty: the real
 * limits. A positive integer: that limit for both (load testing only; a long load run starts one
 * simulated player more than the real per-player cap allows). Anything else throws, so the
 * server refuses to start rather than run with no limit or the wrong one. Takes env as a
 * parameter so it is testable.
 */
export function startLimits(env: Record<string, string | undefined>): StartLimits {
  const raw = env[START_LIMIT_VAR];
  if (raw === undefined || raw === "") return { perIp: RUN_STARTS_PER_WINDOW, perPlayer: RUN_STARTS_PER_PLAYER, raised: false };
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${START_LIMIT_VAR} must be a positive whole number (got "${raw}")`);
  }
  const n = Number(raw);
  return { perIp: n, perPlayer: n, raised: true };
}

/**
 * How many trusted proxies append to X-Forwarded-For (architecture.md, "Client IP behind a
 * proxy"). Unset or empty: 0. A whole number up to MAX_PROXY_HOPS: that. Anything else throws,
 * so the server refuses to start rather than count every viewer as one client.
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
 * The production server's `createApp` options from its environment, plus the lines it prints at
 * startup. `peer` is the socket address. Throws on a bad value, so the server refuses to start.
 */
export function serverOptions(
  env: Record<string, string | undefined>,
  peer: (c: Context) => string,
): { options: AppOptions; startup: string[] } {
  const limits = startLimits(env);
  const hops = proxyHops(env);
  const startup: string[] = [];
  if (limits.raised) startup.push(`run start limits set to ${limits.perIp} per IP and per player per 10 min (load testing only)`);
  if (hops > 0) startup.push(`trusting ${hops} proxy hop(s) in X-Forwarded-For`);
  return {
    options: {
      runStartsPerWindow: limits.perIp,
      runStartsPerPlayer: limits.perPlayer,
      clientIp: clientIpResolver(hops, peer),
      log: (line) => console.log(line),
    },
    startup,
  };
}
