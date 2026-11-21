// Input guards for the two screens a reflexive touch can hit by accident: game over and the
// upgrade choice. Each ignores input for a short time after it opens. Times are ms on one clock
// (performance.now() in the browser); tests pass plain numbers, so no real timers are involved.

/** Game over ignores restart taps and keys this long after death, so a finger still steering doesn't skip the score. */
export const RESTART_DELAY_MS = 800;
/** The upgrade choice ignores card taps and 1-3 this long after it opens, so a re-touch can't pick a card unseen. */
export const CHOICE_DELAY_MS = 350;

/** True once `delayMs` has passed since `openedAt`, so input is accepted again. */
export function inputReady(openedAt: number, now: number, delayMs: number): boolean {
  return now - openedAt >= delayMs;
}
