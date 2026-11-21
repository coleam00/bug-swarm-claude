// The input rate limit for one socket: at most `perSecond` inputs in a fixed one-second window
// that starts at the window's first input. Excess inputs are dropped; the socket stays open. The
// clock is passed in, so it is tested without real time.
import { INPUTS_PER_SECOND } from "../../shared/arena/constants";

export type InputLimiter = {
  /** True if an input arriving at `nowMs` may be used. */
  allow(nowMs: number): boolean;
};

export function createInputLimiter(perSecond: number = INPUTS_PER_SECOND): InputLimiter {
  let windowStart = -Infinity;
  let used = 0;
  return {
    allow(nowMs) {
      if (nowMs - windowStart >= 1000) {
        windowStart = nowMs;
        used = 0;
      }
      if (used >= perSecond) return false;
      used++;
      return true;
    },
  };
}
