// The browser side of the game: the frame loop and input. The rules live in sim.ts; this file
// feeds it input and real time, turns what changed into effects (fx/), and has render.ts draw.
import { arenaForViewport, type Arena } from "./arena";
import { createChanges, detectChanges } from "./fx/changes";
import { BURST_COUNT, createParticles, spawnBurst, updateParticles } from "./fx/particles";
import { createPops, spawnPop, updatePops } from "./fx/pop";
import { HIT_SHAKE, createShake, kick, updateShake } from "./fx/shake";
import { createTexts, spawnText, updateTexts } from "./fx/text";
import { createTrail, updateTrail } from "./fx/trail";
import { createFpsMeter, tickFps } from "./fps";
import type { UpgradeId } from "../../server/rules";
import { CHOICE_KEYS, STATS_KEY, STEERING_KEYS, keysToInput } from "./keys";
import { BUG_LOOKS, GLOW_CYAN, bugLookId } from "./look";
import { STRESS_SECONDS } from "./config";
import { createRenderer, type Fx, type Stats } from "./render";
import { createRng } from "./rng";
import { createStick, stickDown, stickDrive, stickMove, stickReset, stickUp, type StickOut } from "./stick";
import { choose, createState, runResult, step, type Bug, type Input, type RunResult, type State } from "./sim";

export type { RunResult };

export type Game = {
  /** Cancels the loop and removes every listener. */
  stop: () => void;
  /** Takes card `index` of the choice on offer; false if there is no such card. */
  pick: (index: number) => boolean;
};

const STEP = 1 / 60;
/** A frame longer than this (a hitch, a hidden tab) only advances the run this far. */
const MAX_FRAME_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = 8;
/** Seeds fx's own generator. Effects never draw from the simulation's, so they can't change a run. */
const FX_SEED = 0x5eed;
const NONE: Input = { kind: "none" };
/** Stress mode's hands-off steering: a circle around the middle, this big and this fast. */
const AUTO_RADIUS = 0.3;
const AUTO_SPIN = 1.2;
/** Frames a stress run can record: its whole run at up to 240 Hz. */
const BENCH_FRAMES = STRESS_SECONDS * 240;

/** What a stress run records for `bun run bench`, one entry a frame (scripts/bench.ts reads it). */
export type BenchRecord = {
  /** Each frame's real length, ms. */
  frames: Float64Array;
  /** Time spent in render.ts's draw, ms. */
  draws: Float64Array;
  bugs: Float64Array;
  /** Effects alive (see `effectsAlive`). */
  fx: Float64Array;
  /** Frames recorded. */
  count: number;
  /** Set once the run has ended. */
  done: boolean;
};

declare global {
  interface Window {
    bugSwarmBench?: BenchRecord;
  }
}

/** The readout's on or off, kept across runs: F toggles it. */
let showStats = false;

/** Effects alive: pooled particles, floating texts and shield pops in use (the trail and shake are always one each). */
function effectsAlive(fx: Fx): number {
  return fx.particles.live + fx.texts.live + fx.pops.live;
}

/**
 * Plays one run on `canvas` and calls `onOver` once when it ends. The simulation advances in
 * fixed steps by real elapsed time, so its clock tracks the server's on 60, 120 or 144 Hz
 * screens. While an upgrade choice waits it doesn't advance: `onChoice` gets the cards when one
 * comes up and null once `pick` (or keys 1-3) takes one.
 */
export function startGame(
  canvas: HTMLCanvasElement,
  opts: {
    onOver: (result: RunResult) => void;
    onChoice: (cards: readonly UpgradeId[] | null) => void;
    /** A stress run's bug count (stress.ts); 0 or absent for a normal run. */
    stress?: number;
  },
): Game {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const arena: Arena = arenaForViewport(window.innerWidth, window.innerHeight);
  const state: State = createState(Math.floor(Math.random() * 2 ** 32), arena, opts.stress ?? 0);
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

  // The F readout: refreshed when the meter completes a reading, twice a second.
  const meter = createFpsMeter();
  const stats: Stats = { show: showStats, fps: 0, bugs: 0, effects: 0, reading: 0 };

  // Input, recomputed on input events only so the frame loop allocates nothing.
  // Held keys win over the pointer. A touch is a floating joystick (stick.ts) while the first
  // finger is down; the mouse steers toward the cursor while it is over the canvas, and a pressed
  // pen toward the pen, until a key is pressed (then it waits for the next move).
  const keys = new Set<string>();
  const target = { kind: "target" as const, x: 0, y: 0 };
  const stick = createStick();
  const stickOut: StickOut = { kind: "stick", dx: 0, dy: 0 };
  let pointerSteers = false;
  let touch = false;
  let input: Input = NONE;
  const updateInput = () => {
    if (keys.size > 0) input = keysToInput(keys);
    else if (stick.active) input = stickDrive(stick, stickOut) ? stickOut : NONE;
    else input = pointerSteers ? target : NONE;
  };
  const aimAt = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    target.x = (e.clientX - rect.left - offX) / scale;
    target.y = (e.clientY - rect.top - offY) / scale;
  };
  const onTouch = (e: PointerEvent) => {
    touch = true;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (e.type === "pointerdown") {
      if (!stickDown(stick, e.pointerId, x, y)) return; // a second finger is ignored
      pointerSteers = false; // a mouse used earlier doesn't take over when the finger lifts
      try {
        canvas.setPointerCapture(e.pointerId); // keep the moves if the thumb slides off the canvas
      } catch {
        // capture is a nicety; without it the stick lets go at the canvas edge
      }
    } else if (!stickMove(stick, e.pointerId, x, y)) {
      return;
    }
    updateInput();
  };
  const onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") return onTouch(e);
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
    if (e.pointerType === "touch") {
      if (stickUp(stick, e.pointerId)) updateInput(); // only the holding finger lets go
      return;
    }
    if (e.pointerType === "mouse" && e.type !== "pointerleave") return;
    pointerSteers = false;
    updateInput();
  };
  const pick = (index: number): boolean => {
    if (stopped || !choose(state, index)) return false;
    // The mouse that picked steers again once it moves; a finger, once it touches down again.
    pointerSteers = false;
    stickReset(stick);
    updateInput();
    shown = null;
    opts.onChoice(null);
    return true;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === STATS_KEY) {
      if (!e.repeat) stats.show = showStats = !showStats;
      return;
    }
    const card = CHOICE_KEYS.get(e.code);
    if (card !== undefined && state.choice) {
      e.preventDefault();
      if (!e.repeat) pick(card);
      return;
    }
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
    stickReset(stick);
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
    pops: createPops(),
  };
  const onSquash = (b: Bug) => {
    spawnBurst(fx.particles, b.x, b.y, BURST_COUNT, BUG_LOOKS[bugLookId(b)].glow, fxRng);
    spawnText(fx.texts, b.x, b.y);
  };
  const onHit = () => kick(fx.shake, HIT_SHAKE);
  // A blocked hit pops the bubble, with no shake: it should feel unlike losing a life.
  const onBlock = (x: number, y: number) => {
    spawnPop(fx.pops, x, y);
    spawnBurst(fx.particles, x, y, BURST_COUNT, GLOW_CYAN, fxRng);
  };

  // A stress run steers itself while the player doesn't, so the trail and moving fire rate are in
  // the measurement, and records each frame for the bench. Off (and allocated not at all) otherwise.
  const auto = { kind: "target" as const, x: 0, y: 0 };
  const bench: BenchRecord | null =
    state.stress > 0
      ? {
          frames: new Float64Array(BENCH_FRAMES),
          draws: new Float64Array(BENCH_FRAMES),
          bugs: new Float64Array(BENCH_FRAMES),
          fx: new Float64Array(BENCH_FRAMES),
          count: 0,
          done: false,
        }
      : null;
  if (bench) window.bugSwarmBench = bench;

  let raf = 0;
  let last: number | null = null;
  let acc = 0;
  let stopped = false;
  /** The choice last reported to `onChoice`, so it is reported once. */
  let shown: readonly UpgradeId[] | null = null;
  const frame = (ts: number) => {
    if (stopped) return;
    const real = last === null ? 0 : (ts - last) / 1000;
    const delta = Math.min(real, MAX_FRAME_SECONDS);
    last = ts;
    acc += delta;
    let steps = 0;
    while (acc >= STEP && steps < MAX_STEPS_PER_FRAME && !state.over && !state.choice) {
      let using = input;
      if (bench && input === NONE) {
        const r = AUTO_RADIUS * Math.min(arena.w, arena.h);
        auto.x = arena.w / 2 + r * Math.cos(state.time * AUTO_SPIN);
        auto.y = arena.h / 2 + r * Math.sin(state.time * AUTO_SPIN);
        using = auto;
      }
      step(state, using, STEP);
      acc -= STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) acc = 0; // fell behind: drop the rest rather than spiral
    if (state.choice) {
      acc = 0; // the pause isn't owed back as a burst of steps when play resumes
      if (state.choice !== shown) opts.onChoice((shown = state.choice));
    }
    detectChanges(fx.changes, state, onSquash, onHit, onBlock);
    updateTrail(fx.trail, state.robot.x, state.robot.y, delta);
    updateParticles(fx.particles, delta);
    updateTexts(fx.texts, delta);
    updatePops(fx.pops, delta);
    updateShake(fx.shake, delta, fxRng);
    if (real > 0 && tickFps(meter, real)) {
      stats.fps = meter.fps;
      stats.bugs = state.bugs.length;
      stats.effects = effectsAlive(fx);
      stats.reading++;
    }
    if (bench) {
      const t0 = performance.now();
      renderer.draw(state, fx, stats, stick);
      const i = bench.count;
      if (i < BENCH_FRAMES) {
        bench.draws[i] = performance.now() - t0;
        bench.frames[i] = real * 1000;
        bench.bugs[i] = state.bugs.length;
        bench.fx[i] = effectsAlive(fx);
        bench.count++;
      }
      if (state.over) bench.done = true;
    } else {
      renderer.draw(state, fx, stats, stick);
    }
    if (state.over) {
      stop();
      opts.onOver(runResult(state, touch));
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
  return { stop, pick };
}
