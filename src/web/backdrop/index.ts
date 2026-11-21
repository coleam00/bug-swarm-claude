// The start screen's backdrop on a canvas: the simulation in sim.ts stepped and drawn every
// frame. It is decoration: the canvas takes no input, the loop stops while the tab is hidden and
// when the screen goes, and with reduced motion it draws one still frame. This is the seam
// release 2 swaps for the live arena: the start screen mounts whatever this module starts.
import { createParticles, spawnBurst, updateParticles, BURST_COUNT } from "../game/fx/particles";
import { createTrail, updateTrail } from "../game/fx/trail";
import { createRng } from "../game/rng";
import { createBackdropDraw } from "./draw";
import { ROBOTS, backdropWorld, createBackdrop, resizeBackdrop, stepBackdrop } from "./sim";

/** Fixed, so the backdrop (and its screenshots) repeat. It has no score, so this costs nothing. */
export const BACKDROP_SEED = 51;
const PARTICLES = 256;
const COST_FRAMES = 3600;
const STILL_SECONDS = 3;

/**
 * Each frame's cost (step, effects and draw) in ms, for measuring: `work` is a ring of the last
 * COST_FRAMES frames, `count` the frames so far. Dev server only.
 */
export type BackdropRecord = { work: Float64Array; count: number; running: boolean };

declare global {
  interface Window {
    bugSwarmBackdrop?: BackdropRecord;
  }
}

const MEASURE = import.meta.env.DEV;

export function startBackdrop(canvas: HTMLCanvasElement): { stop(): void } {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const painter = createBackdropDraw(ctx);
  const sim = createBackdrop(BACKDROP_SEED, backdropWorld(innerWidth, innerHeight));
  const particles = createParticles(PARTICLES);
  const trails = Array.from({ length: ROBOTS }, createTrail);
  const fx = { particles, trails };
  const fxRng = createRng(BACKDROP_SEED + 1);
  const onPop = (x: number, y: number, glow: number) => spawnBurst(particles, x, y, BURST_COUNT, glow, fxRng);
  const record: BackdropRecord | null = MEASURE ? { work: new Float64Array(COST_FRAMES), count: 0, running: false } : null;
  if (record) window.bugSwarmBackdrop = record;

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let raf = 0;
  let last: number | null = null;
  let stopped = false;

  const advance = (dt: number) => {
    stepBackdrop(sim, dt, onPop);
    updateParticles(particles, dt);
    for (let r = 0; r < ROBOTS; r++) updateTrail(trails[r]!, sim.robotX[r]!, sim.robotY[r]!, dt);
  };

  const resize = () => {
    const w = innerWidth;
    const h = innerHeight;
    const world = backdropWorld(w, h);
    resizeBackdrop(sim, world);
    painter.resize(w, h, devicePixelRatio || 1, world);
    if (still || !raf) painter.draw(sim, fx);
  };

  const frame = (ts: number) => {
    raf = requestAnimationFrame(frame);
    const t0 = performance.now();
    advance(last === null ? 0 : (ts - last) / 1000);
    last = ts;
    painter.draw(sim, fx);
    if (record) {
      record.work[record.count % COST_FRAMES] = performance.now() - t0;
      record.count++;
    }
  };

  const run = () => {
    if (stopped || still || raf || document.hidden) return;
    last = null;
    raf = requestAnimationFrame(frame);
    if (record) record.running = true;
  };
  const pause = () => {
    cancelAnimationFrame(raf);
    raf = 0;
    if (record) record.running = false;
  };
  const onVisibility = () => (document.hidden ? pause() : run());

  if (still) for (let n = 0; n < STILL_SECONDS * 60; n++) advance(1 / 60);
  resize();
  run();
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    stop() {
      stopped = true;
      pause();
      removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
