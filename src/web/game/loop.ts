// The browser side of the game: the frame loop and input. The rules live in sim.ts; this file
// feeds it input and real time, turns what changed into effects (fx/), and has render.ts draw.
import { arenaForViewport, type Arena } from "./arena";
import { createChanges, detectChanges } from "./fx/changes";
import { BURST_COUNT, createParticles, spawnBurst, updateParticles } from "./fx/particles";
import { HIT_SHAKE, createShake, kick, updateShake } from "./fx/shake";
import { createTexts, spawnText, updateTexts } from "./fx/text";
import { createTrail, updateTrail } from "./fx/trail";
import { STEERING_KEYS, keysToInput } from "./keys";
import { BUG_LOOKS, bugLookId } from "./look";
import { createRenderer, type Fx } from "./render";
import { createRng } from "./rng";
import { createState, score, step, type Bug, type Input, type State } from "./sim";

export type RunResult = { score: number; squashes: number; seconds: number; touch: boolean };

const STEP = 1 / 60;
/** A frame longer than this (a hitch, a hidden tab) only advances the run this far. */
const MAX_FRAME_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = 8;
/** Seeds fx's own generator. Effects never draw from the simulation's, so they can't change a run. */
const FX_SEED = 0x5eed;
const NONE: Input = { kind: "none" };

/**
 * Plays one run on `canvas` and calls `onOver` once when it ends. The simulation advances in
 * fixed steps by real elapsed time, so its clock tracks the server's on 60, 120 or 144 Hz
 * screens. Returns `stop`, which cancels the loop and removes every listener.
 */
export function startGame(canvas: HTMLCanvasElement, opts: { onOver: (result: RunResult) => void }): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const arena: Arena = arenaForViewport(window.innerWidth, window.innerHeight);
  const state: State = createState(Math.floor(Math.random() * 2 ** 32), arena);
  const renderer = createRenderer(ctx, arena);

  // Layout: the arena scaled to fit the canvas and centered (letterboxed), in CSS px.
  let dpr = 1;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  const resize = () => {
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    scale = Math.min(w / arena.w, h / arena.h);
    offX = (w - arena.w * scale) / 2;
    offY = (h - arena.h * scale) / 2;
    renderer.resize(dpr, scale, offX, offY);
  };
  resize();

  // Input, recomputed on input events only so the frame loop allocates nothing.
  // Held keys win over the pointer. A touch steers while the finger is down; the mouse steers
  // while it is over the canvas, until a key is pressed (then it waits for the next move).
  const keys = new Set<string>();
  const target = { kind: "target" as const, x: 0, y: 0 };
  let pointerSteers = false;
  let touch = false;
  let input: Input = NONE;
  const updateInput = () => {
    input = keys.size > 0 ? keysToInput(keys) : pointerSteers ? target : NONE;
  };
  const aimAt = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    target.x = (e.clientX - rect.left - offX) / scale;
    target.y = (e.clientY - rect.top - offY) / scale;
  };
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") touch = true;
    if (e.pointerType === "mouse") {
      pointerSteers = true;
    } else if (e.type === "pointerdown") {
      pointerSteers = true;
    } else if (e.buttons === 0) {
      return; // a pen hovering: only a pressed finger or pen steers
    }
    aimAt(e);
    updateInput();
  };
  const onPointerEnd = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.type !== "pointerleave") return;
    pointerSteers = false;
    updateInput();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!STEERING_KEYS.has(e.code)) return;
    e.preventDefault();
    keys.add(e.code);
    pointerSteers = false;
    updateInput();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (keys.delete(e.code)) updateInput();
  };
  const onBlur = () => {
    keys.clear();
    updateInput();
  };

  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerup", onPointerEnd);
  canvas.addEventListener("pointercancel", onPointerEnd);
  canvas.addEventListener("pointerleave", onPointerEnd);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", resize);

  // Effects, all created once. The callbacks are made here so the frame loop allocates nothing.
  const fxRng = createRng(FX_SEED);
  const fx: Fx = {
    changes: createChanges(fxRng),
    particles: createParticles(),
    texts: createTexts(),
    trail: createTrail(),
    shake: createShake(),
  };
  const onSquash = (b: Bug) => {
    spawnBurst(fx.particles, b.x, b.y, BURST_COUNT, BUG_LOOKS[bugLookId(b)].glow, fxRng);
    spawnText(fx.texts, b.x, b.y);
  };
  const onHit = () => kick(fx.shake, HIT_SHAKE);

  let raf = 0;
  let last: number | null = null;
  let acc = 0;
  let stopped = false;
  const frame = (ts: number) => {
    if (stopped) return;
    const delta = last === null ? 0 : Math.min((ts - last) / 1000, MAX_FRAME_SECONDS);
    last = ts;
    acc += delta;
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME && !state.over) {
      step(state, input, STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0; // fell behind: drop the rest rather than spiral
    detectChanges(fx.changes, state, onSquash, onHit);
    updateTrail(fx.trail, state.robot.x, state.robot.y, delta);
    updateParticles(fx.particles, delta);
    updateTexts(fx.texts, delta);
    updateShake(fx.shake, delta, fxRng);
    renderer.draw(state, fx);
    if (state.over) {
      stop();
      opts.onOver({ score: score(state), squashes: state.squashes, seconds: state.time, touch });
      return;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  function stop() {
    stopped = true;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onPointer);
    canvas.removeEventListener("pointermove", onPointer);
    canvas.removeEventListener("pointerup", onPointerEnd);
    canvas.removeEventListener("pointercancel", onPointerEnd);
    canvas.removeEventListener("pointerleave", onPointerEnd);
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("resize", resize);
  }
  return stop;
}
