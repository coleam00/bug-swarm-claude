// The steering hint over the arena on a browser's first run: "Drag anywhere to move" on touch,
// "WASD, arrows or mouse" otherwise. It goes on the first movement or after HINT_MS.
// Remembered in localStorage; where that is unavailable it shows once per page load.
// Times are passed in (performance.now() in the browser), as guard.ts does.

const KEY = "bugswarm.hinted";
/** How long the hint stays when the player doesn't move. */
export const HINT_MS = 4000;

let memory = false;

/** True only if this browser has never been shown the hint; it counts as shown from this call. */
export function takeFirstRun(): boolean {
  let seen = memory;
  try {
    seen ||= localStorage.getItem(KEY) !== null;
  } catch {
    // Storage is unavailable: the memory flag decides.
  }
  memory = true;
  if (seen) return false;
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Storage is unavailable: shown once for this page.
  }
  return true;
}

export function hintText(coarse: boolean): string {
  return coarse ? "Drag anywhere to move" : "WASD, arrows or mouse";
}

export type Hint = { shownAt: number; gone: boolean };

export function createHint(now: number): Hint {
  return { shownAt: now, gone: false };
}

/** The player moved: the hint goes. */
export function dismissHint(h: Hint): void {
  h.gone = true;
}

/** Ms until the hint must be gone at `now`; 0 once it is dismissed or HINT_MS has passed. */
export function hintLeft(h: Hint, now: number): number {
  return h.gone ? 0 : Math.max(0, h.shownAt + HINT_MS - now);
}

/** For tests: forget the in-memory flag, as a fresh page load would. */
export function forgetHintForTests(): void {
  memory = false;
}
