import { RUN_STARTS_PER_WINDOW } from "./app";

/** The env var that raises the per-IP run start limit, for `bun run load` only. Never set in production. */
export const START_LIMIT_VAR = "RUN_STARTS_PER_WINDOW";

/**
 * The run starts allowed per IP per window. Unset or empty: the real limit. A positive integer:
 * that limit (load testing only). Anything else throws, so the server refuses to start rather
 * than run with no limit or the wrong one. Takes env as a parameter so it is testable.
 */
export function startLimit(env: Record<string, string | undefined>): number {
  const raw = env[START_LIMIT_VAR];
  if (raw === undefined || raw === "") return RUN_STARTS_PER_WINDOW;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${START_LIMIT_VAR} must be a positive whole number (got "${raw}")`);
  }
  return Number(raw);
}
