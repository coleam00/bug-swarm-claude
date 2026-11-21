// The input guard for the life-over screen: a reflexive tap or key right after a life ends must
// not skip the score. Pure, with the time passed in (performance.now() in the browser, plain
// numbers in tests).

/** "Play again" ignores taps and keys this long after the life ended, so a finger still steering doesn't skip the score. */
export const RESTART_DELAY_MS = 800;

/** Ms until "Play again" works, for a life that ended at `diedAt`; 0 once it does. */
export function restartIn(diedAt: number, now: number): number {
  return Math.max(0, diedAt + RESTART_DELAY_MS - now);
}
