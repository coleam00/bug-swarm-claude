// The steering hint over the arena on a browser's first run: "Drag anywhere to move" on touch,
// "WASD, arrows or mouse" otherwise. It goes on the first movement or after HINT_MS.
// Remembered in localStorage; where that is unavailable it shows once per page load.
// loop.ts calls firstSteer from its input events to tell App the player has moved.
import type { Input } from "./game/sim";

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

/** Whether the run has had its first steering input yet. */
export type SteerLatch = { moved: boolean };

export function createSteerLatch(): SteerLatch {
  return { moved: false };
}

/**
 * True exactly once: for the run's first input that steers. Checked by kind, not identity:
 * opposing keys held together (A+D) give a fresh { kind: "none" }, which is no movement.
 */
export function firstSteer(latch: SteerLatch, input: Input): boolean {
  if (latch.moved || input.kind === "none") return false;
  latch.moved = true;
  return true;
}

/** For tests: forget the in-memory flag, as a fresh page load would. */
export function forgetHintForTests(): void {
  memory = false;
}
