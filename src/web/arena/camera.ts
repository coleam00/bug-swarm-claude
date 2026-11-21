// The camera: which part of the world is on screen. Its view has release 1's arena area (360,000
// units², arenaForViewport), so a robot is the same size on screen as on `/`; a screen wider or
// taller than 16:9 sees a little less, filling it rather than letterboxing. It follows your
// robot with exponential smoothing and stops at the world's edge plus a margin, so the glowing
// wall shows; a view wider than the world centres it. Pure.
import { WORLD_H, WORLD_W } from "../../shared/arena/constants";
import { arenaForViewport } from "../game/arena";

/** Smoothing time constant, seconds: about how long the camera takes to catch most of a move. */
export const CAMERA_SECONDS = 0.12;
/** How far past the wall the view may go, units. */
export const CAMERA_MARGIN = 60;

export type Camera = {
  /** The view's centre, world units. */
  x: number;
  y: number;
  /** The view's size, world units. */
  w: number;
  h: number;
  /** CSS px per world unit. */
  scale: number;
};

export function createCamera(cssW: number, cssH: number): Camera {
  const cam = { x: WORLD_W / 2, y: WORLD_H / 2, w: 0, h: 0, scale: 1 };
  setViewport(cam, cssW, cssH);
  return cam;
}

/** The screen changed size: the view keeps its area and takes the screen's shape. */
export function setViewport(cam: Camera, cssW: number, cssH: number): void {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  const view = arenaForViewport(w, h);
  cam.scale = Math.max(w / view.w, h / view.h);
  cam.w = w / cam.scale;
  cam.h = h / cam.scale;
  clampCamera(cam);
}

function clampAxis(c: number, view: number, world: number): number {
  const lo = view / 2 - CAMERA_MARGIN;
  const hi = world - view / 2 + CAMERA_MARGIN;
  return lo > hi ? world / 2 : Math.min(hi, Math.max(lo, c));
}

export function clampCamera(cam: Pick<Camera, "x" | "y" | "w" | "h">): void {
  cam.x = clampAxis(cam.x, cam.w, WORLD_W);
  cam.y = clampAxis(cam.y, cam.h, WORLD_H);
}

/** Moves toward (tx, ty) over `dt` seconds, the same at any frame rate. */
export function followCamera(cam: Camera, tx: number, ty: number, dt: number): void {
  const k = 1 - Math.exp(-dt / CAMERA_SECONDS);
  cam.x += (clampAxis(tx, cam.w, WORLD_W) - cam.x) * k;
  cam.y += (clampAxis(ty, cam.h, WORLD_H) - cam.y) * k;
}

/** Jumps straight to (tx, ty): a join or a rejoin. */
export function snapCamera(cam: Pick<Camera, "x" | "y" | "w" | "h">, tx: number, ty: number): void {
  cam.x = tx;
  cam.y = ty;
  clampCamera(cam);
}
