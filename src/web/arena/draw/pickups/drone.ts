// The CI drone (#84): a rotor glyph, and release 1's drone orbiting every robot that has it, a dark
// body with a violet rim in its own pulsing violet glow. The orbit is the simulation's own
// (shared pickups/drone.ts droneAngle), drawn on the robot's tick clock, so a drone shot leaves
// from where the drone is drawn. Its shots are drawn violet (render.ts drawShots).
import { DRONE_ORBIT, droneAngle } from "../../../../shared/arena/pickups/drone";
import { DRONE_BODY, DRONE_RIM, DRONE_RIM_WIDTH, GLOW_DRONE, PALETTE } from "../../../game/look";
import type { PickupDraw } from "./kind";

const COLOUR = PALETTE[GLOW_DRONE];
/** The drone's drawn radius, world units (release 1's DRONE_RADIUS). */
const DRONE_RADIUS = 8;
/** Its glow's size, in drone radii, and how it pulses (release 1's). */
const GLOW_SIZE = 3.2;
const GLOW_PULSE = 0.3;
const GLOW_PULSE_RATE = 10;
const TAU = Math.PI * 2;

/** Where player `id`'s drone is drawn at tick `tick` around a robot at (x, y): written into `out`. */
export function droneSpot(x: number, y: number, id: number, tick: number, out: { x: number; y: number }): void {
  const a = droneAngle(tick, id);
  out.x = x + Math.cos(a) * DRONE_ORBIT;
  out.y = y + Math.sin(a) * DRONE_ORBIT;
}

const spot = { x: 0, y: 0 };

export const droneDraw: PickupDraw = {
  glow: GLOW_DRONE,
  glyph(ctx, x, y, size) {
    const h = size / 2;
    // A disc with a violet rim and two rotor arms across it.
    ctx.fillStyle = DRONE_BODY;
    ctx.strokeStyle = COLOUR;
    ctx.lineWidth = Math.max(1.5, size * 0.12);
    ctx.beginPath();
    ctx.arc(x, y, h * 0.5, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - h * 0.95, y - h * 0.55);
    ctx.lineTo(x - h * 0.45, y - h * 0.55);
    ctx.moveTo(x + h * 0.45, y - h * 0.55);
    ctx.lineTo(x + h * 0.95, y - h * 0.55);
    ctx.stroke();
    ctx.lineCap = "butt";
  },
  on(ctx, x, y, _aim, t, glow, id, tick) {
    droneSpot(x, y, id, tick, spot);
    ctx.fillStyle = DRONE_BODY;
    ctx.strokeStyle = DRONE_RIM;
    ctx.lineWidth = DRONE_RIM_WIDTH;
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, DRONE_RADIUS, 0, TAU);
    ctx.fill();
    ctx.stroke();
    const g = DRONE_RADIUS * (GLOW_SIZE + GLOW_PULSE * Math.sin(t * GLOW_PULSE_RATE));
    const was = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = "lighter";
    ctx.drawImage(glow, spot.x - g, spot.y - g, g * 2, g * 2);
    ctx.globalCompositeOperation = was;
  },
};
