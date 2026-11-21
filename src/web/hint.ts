// The controls hint on a browser's first arena life (#64): one short line that fades in and out at
// the bottom of the screen, "WASD move · mouse aim · hold to fire · Space dash" on a computer and
// "left thumb moves · right thumb aims and fires" on a touch screen. Never again after that.
// Remembered in localStorage under its own key (release 1's hint used `bugswarm.hinted`, which its
// players already have); where storage is unavailable it shows once per page load. App.tsx takes it
// when the arena first puts you in a life, so a refused join does not use it up.

const KEY = "bugswarm.arenaHinted";
/** How long the hint is on screen, fade in and out included (index.html's `.hint` animation). */
export const HINT_MS = 5000;

let memory = false;

/** True only if this browser has never been shown the arena hint; it counts as shown from this call. */
export function takeFirstLife(): boolean {
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

/** The hint for a touch screen (`coarse`) or a computer. */
export function hintText(coarse: boolean): string {
  return coarse ? "left thumb moves · right thumb aims and fires" : "WASD move · mouse aim · hold to fire · Space dash";
}

/** For tests: forget the in-memory flag, as a fresh page load would. */
export function forgetHintForTests(): void {
  memory = false;
}
