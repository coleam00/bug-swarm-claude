// The browser side of the game: the frame loop, input and drawing. The rules live in sim.ts;
// this file only feeds it input and real time, and draws its state.
import { arenaForViewport, type Arena } from "./arena";
import { STEERING_KEYS, keysToInput } from "./keys";
import { BUG_KINDS, MAX_HITS, ROBOT_RADIUS } from "./config";
import { createState, score, step, type Input, type State } from "./sim";

export type RunResult = { score: number; squashes: number; seconds: number; touch: boolean };

const STEP = 1 / 60;
/** A frame longer than this (a hitch, a hidden tab) only advances the run this far. */
const MAX_FRAME_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = 8;
const HUD_FONT = "bold 28px system-ui, sans-serif";
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

  // HUD text is rebuilt only when a value changes.
  let hudScore = -1;
  let hudHits = -1;
  let hudSecond = -1;
  let scoreText = "";
  let hitsText = "";
  let timeText = "";

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * offX, dpr * offY);
    ctx.fillStyle = "#111827";
    ctx.fillRect(0, 0, arena.w, arena.h);

    // One path and one fill per kind of bug.
    for (const kind of BUG_KINDS) {
      ctx.fillStyle = kind.color;
      ctx.beginPath();
      for (const b of state.bugs) {
        if (b.kind !== kind) continue;
        ctx.moveTo(b.x + kind.radius, b.y);
        ctx.arc(b.x, b.y, kind.radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }

    ctx.fillStyle = "#fde047";
    for (const s of state.shots) ctx.fillRect(s.x - 3, s.y - 3, 6, 6);

    const flashing = state.invuln > 0 && Math.floor(state.invuln * 12) % 2 === 0;
    ctx.fillStyle = flashing ? "#ffffff" : "#22d3ee";
    ctx.beginPath();
    ctx.arc(state.robot.x, state.robot.y, ROBOT_RADIUS, 0, Math.PI * 2);
    ctx.fill();

    const sc = score(state);
    const hitsLeft = Math.max(0, MAX_HITS - state.hits);
    const second = Math.floor(state.time);
    if (sc !== hudScore) scoreText = `Score ${(hudScore = sc)}`;
    if (hitsLeft !== hudHits) hitsText = "♥".repeat((hudHits = hitsLeft)) || "-";
    if (second !== hudSecond) timeText = `${(hudSecond = second)}s`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = HUD_FONT;
    ctx.textBaseline = "top";
    ctx.fillStyle = "#f8fafc";
    const w = canvas.width / dpr;
    ctx.textAlign = "left";
    ctx.fillText(scoreText, 16, 16);
    ctx.textAlign = "center";
    ctx.fillText(timeText, w / 2, 16);
    ctx.textAlign = "right";
    ctx.fillStyle = "#f43f5e";
    ctx.fillText(hitsText, w - 16, 16);
  };

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
    draw();
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
