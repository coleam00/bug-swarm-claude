// The frame-rate meter behind the F readout: frames counted over a half-second window. Pure:
// the loop passes each frame's real length, so it reads no clock and allocates nothing.

/** Seconds of frames each reading covers. */
export const FPS_WINDOW = 0.5;

export type FpsMeter = {
  /** The last reading, in frames a second; 0 before the first window fills. */
  fps: number;
  frames: number;
  seconds: number;
};

export function createFpsMeter(): FpsMeter {
  return { fps: 0, frames: 0, seconds: 0 };
}

/** Counts one frame of `dt` seconds. True when it completed a window and `fps` was updated. */
export function tickFps(m: FpsMeter, dt: number): boolean {
  m.frames++;
  m.seconds += dt;
  if (m.seconds < FPS_WINDOW - 1e-9) return false;
  m.fps = m.frames / m.seconds;
  m.frames = 0;
  m.seconds = 0;
  return true;
}
