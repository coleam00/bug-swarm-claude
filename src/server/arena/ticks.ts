// How long arena ticks take, for GET /api/arena/stats: a ring of (when, how long) shared by every
// arena. Writing allocates nothing. Its 24,000 slots hold a minute of 20 arenas at 20 Hz; with
// more arenas the oldest samples fall out first, so the percentiles cover less than a minute.

export const TICK_LOG_SIZE = 24_000;
/** The stats look back this far, ms. */
export const TICK_WINDOW_MS = 60_000;

export type TickLog = {
  record(atMs: number, durationMs: number): void;
  /** p50 and p95 tick durations (ms) over the last TICK_WINDOW_MS before `nowMs`; null with no samples. */
  percentiles(nowMs: number): { p50: number | null; p95: number | null };
};

export function createTickLog(size: number = TICK_LOG_SIZE): TickLog {
  const at = new Float64Array(size);
  const dur = new Float64Array(size);
  let next = 0;
  let count = 0;
  return {
    record(atMs, durationMs) {
      at[next] = atMs;
      dur[next] = durationMs;
      next = (next + 1) % size;
      if (count < size) count++;
    },
    percentiles(nowMs) {
      const recent: number[] = [];
      for (let i = 0; i < count; i++) if (nowMs - at[i]! <= TICK_WINDOW_MS) recent.push(dur[i]!);
      if (recent.length === 0) return { p50: null, p95: null };
      recent.sort((a, b) => a - b);
      const pick = (p: number) => recent[Math.min(recent.length - 1, Math.ceil(p * recent.length) - 1)]!;
      return { p50: pick(0.5), p95: pick(0.95) };
    },
  };
}
