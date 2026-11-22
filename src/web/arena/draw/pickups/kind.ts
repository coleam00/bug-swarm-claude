// What drawing a pickup takes (#73): one file per pickup in this folder exports a PickupDraw,
// listed in index.ts by pickup id. render.ts draws a floor pickup as a soft halo in its glow, a
// dark disc and its glyph (blinking in its last PICKUP_BLINK_S), the same glyph in your HUD timer,
// and `on` over every robot that has it.
import { PICKUP_BLINK_S } from "../../../../shared/arena/constants";

export type PickupDraw = {
  /** Its glow, an index into PALETTE: the floor halo, the HUD ring, the pickup burst. */
  glow: number;
  /** Its glyph, centred on (x, y), `size` across, in whatever transform is set. Leaves the canvas state as it found it. */
  glyph(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void;
  /**
   * Optional: what it draws on a robot that has it (world units), the robot at (x, y) aiming
   * `aim`, at `t` seconds; `glow` is a soft glow sprite in its colour; `id` is the robot's player
   * id and `tick` the (fractional) server tick it is drawn at, the same clock its shots are drawn
   * on (#84: the CI drone's orbit is a function of both). Drawn for every player, so others see
   * it. Leaves the canvas state as it found it.
   */
  on?(ctx: CanvasRenderingContext2D, x: number, y: number, aim: number, t: number, glow: HTMLCanvasElement, id: number, tick: number): void;
};

/** A floor pickup blinks this many times a second in its last PICKUP_BLINK_S. */
export const PICKUP_BLINK_HZ = 5;
/** Its opacity in the off half of a blink. */
export const PICKUP_BLINK_LOW = 0.2;

/** A floor pickup's opacity with `secondsLeft` before it goes: 1, then blinking in the last PICKUP_BLINK_S. */
export function floorAlpha(secondsLeft: number): number {
  if (secondsLeft > PICKUP_BLINK_S) return 1;
  return Math.floor(secondsLeft * PICKUP_BLINK_HZ * 2) % 2 === 0 ? PICKUP_BLINK_LOW : 1;
}
