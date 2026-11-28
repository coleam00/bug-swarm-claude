// The controls card (#134, was #64's one-line hint): four short lines that fade in and out near
// the bottom of the arena for HINT_MS at the start of each of a browser's first HINT_LIVES lives,
// then never again. A computer gets keys and mouse, a touch screen thumbs and the DASH button; both
// say how to dash and how to revive. App.tsx takes a life each time the arena puts you in one
// (`alive`), so a refused join uses none. Counted in localStorage under its own key: release 1's
// `bugswarm.hinted` and #64's `bugswarm.arenaHinted` are ignored, so their players see all three.
// Where storage is unavailable the count lives in memory, so three per page load.

const KEY = "bugswarm.arenaHintLives";
/** How many lives get the card. */
export const HINT_LIVES = 3;
/** How long the card is on screen, fade in and out included (index.html's `.hint` animation). */
export const HINT_MS = 10000;

let memory = 0;

/** True while this browser has had the card on fewer than HINT_LIVES lives; this call counts as one. */
export function takeHintLife(): boolean {
  let count = memory;
  try {
    const stored = parseInt(localStorage.getItem(KEY) ?? "", 10);
    if (stored > count) count = stored;
  } catch {
    // Storage is unavailable: the memory count decides.
  }
  if (count >= HINT_LIVES) return false;
  memory = count + 1;
  try {
    localStorage.setItem(KEY, String(memory));
  } catch {
    // Storage is unavailable: counted for this page only.
  }
  return true;
}

/** The card's lines for a touch screen (`coarse`) or a computer. */
export function hintLines(coarse: boolean): string[] {
  return coarse
    ? ["Left thumb: move", "Right thumb: aim + fire", "DASH button: dodge", "Stand by a downed player to revive"]
    : ["WASD move", "Mouse aim, hold to fire", "Space / right-click: dash", "Stand by a downed player to revive"];
}

/** For tests: forget the in-memory count, as a fresh page load would. */
export function forgetHintForTests(): void {
  memory = 0;
}
