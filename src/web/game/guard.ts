// Input guards for the two screens a reflexive touch can hit by accident: game over and the
// upgrade choice. Each ignores input for a short time after it opens. The decisions live here,
// pure, with the time passed in (performance.now() in the browser, plain numbers in tests).
import type { UpgradeId } from "../../server/rules";
import { choose, type State } from "./sim";

/** Game over ignores restart taps and keys this long after death, so a finger still steering doesn't skip the score. */
export const RESTART_DELAY_MS = 800;
/** The upgrade choice ignores card taps and 1-3 this long after it opens, so a re-touch can't pick a card unseen. */
export const CHOICE_DELAY_MS = 350;

/** Ms until game over accepts a restart, for a run that ended at `diedAt`; 0 once it does. */
export function restartIn(diedAt: number, now: number): number {
  return Math.max(0, diedAt + RESTART_DELAY_MS - now);
}

/** The choice on screen and when it opened. */
export type ChoiceGate = { shown: readonly UpgradeId[] | null; openedAt: number };

export function createChoiceGate(): ChoiceGate {
  return { shown: null, openedAt: -Infinity };
}

/** Notes the choice on offer at `now`; true the first time this choice is seen (show it then). */
export function showChoice(gate: ChoiceGate, choice: readonly UpgradeId[], now: number): boolean {
  if (choice === gate.shown) return false;
  gate.shown = choice;
  gate.openedAt = now;
  return true;
}

/**
 * Takes card `index` for a press (tap down or key down) at `pressedAt`. Refused, with the state
 * unchanged, unless that choice is on screen and was shown at least CHOICE_DELAY_MS before the press.
 */
export function pickChoice(gate: ChoiceGate, state: State, index: number, pressedAt: number): boolean {
  if (!state.choice || state.choice !== gate.shown) return false;
  if (pressedAt - gate.openedAt < CHOICE_DELAY_MS) return false;
  if (!choose(state, index)) return false;
  gate.shown = null;
  return true;
}
