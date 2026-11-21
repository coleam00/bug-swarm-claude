// Stress mode's switch: `?stress=150` (or a bare `?stress`) starts a run held at that many bugs
// with every upgrade, for measuring the frame rate (`bun run bench`). It works only in the dev
// server and in the bench build (`vite build --mode bench`); a production build folds the gate
// to false and drops the rest. A stress run is never submitted in any build (App.tsx).
import { MAX_BUGS, STRESS_DEFAULT } from "./game/config";

/** The bugs a stress run holds, from the page's query string; 0 for a normal run. */
export function parseStress(search: string, allowed: boolean): number {
  if (!allowed) return 0;
  const value = new URLSearchParams(search).get("stress");
  if (value === null) return 0;
  if (value === "") return STRESS_DEFAULT;
  if (!/^\d+$/.test(value)) return 0;
  const n = Number(value);
  return n >= 1 && n <= MAX_BUGS ? n : 0;
}

const ALLOWED = import.meta.env.DEV || import.meta.env.MODE === "bench";

/** This page's stress count: 0 in production, and under `bun test` (no `location`). */
export const STRESS = ALLOWED && typeof location !== "undefined" ? parseStress(location.search, true) : 0;
