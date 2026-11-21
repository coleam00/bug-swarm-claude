// The /arena page (release 2): plain TypeScript, no React. With a name and a team (the same
// local player `/` keeps; without them, `/` asks first), it joins an arena over the WebSocket and
// runs the frame loop: every local 50 ms step reads the controls, sends one input and predicts
// your robot with it; every frame draws you between predicted steps, everyone else ~100 ms behind
// the server, and the camera following you.
import { TICK_MS } from "../../shared/arena/constants";
import { ERROR_NAME, EVENT, JOIN, LEAVE, SNAPSHOT, WELCOME, encodeInput, type ServerMessage } from "../../shared/arena/protocol";
import { clampInput, type Input } from "../../shared/arena/sim";
import { isTeam, type Team } from "../../server/rules";
import { createFpsMeter, tickFps } from "../game/fps";
import { createTrail, updateTrail } from "../game/fx/trail";
import type { Insets } from "../game/hud";
import { STATS_KEY, STEERING_KEYS } from "../game/keys";
import { loadPlayer, nextScreen, setPlayerName } from "../player";
import { createCamera, followCamera, setViewport, snapCamera } from "./camera";
import { createControls, pointerDown, pointerMove, pointerUp, readControls, releaseAll, type PointerKind } from "./controls";
import { createInterp, newestPlayers, pushSnapshot, renderTick, resetInterp, sample } from "./interp";
import { connectArena } from "./net";
import { createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor } from "./predict";
import { createArenaRenderer, type Robot } from "./render";

/** Local steps one frame may run; a stalled tab drops the rest rather than burst inputs. */
const MAX_STEPS_PER_FRAME = 3;

const player = loadPlayer();
if (nextScreen(player, false) !== "play" || player.name === null || player.team === null) {
  location.replace("/");
} else {
  start(player.id, player.name, player.team);
}

function start(playerId: string, name: string, team: Team): void {
  const canvas = document.getElementById("arena") as HTMLCanvasElement;
  const statusEl = document.getElementById("status") as HTMLElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const renderer = createArenaRenderer(ctx);
  const cam = createCamera(window.innerWidth, window.innerHeight);
  const controls = createControls(window.innerWidth);
  const predictor = createPredictor();
  const interp = createInterp();

  // Who is in the arena: names and teams come once, in the welcome and in join events.
  const roster = new Map<number, Robot>();
  /** The robots drawn this frame, reused. */
  const drawn: Robot[] = [];
  let you: number | null = null;
  let spawned = false;
  let seq = 0;

  const robotFor = (id: number, n: string, t: Team): Robot => {
    let r = roster.get(id);
    if (!r) {
      r = { id, x: 0, y: 0, aim: 0, name: n, team: t, trail: createTrail() };
      roster.set(id, r);
    }
    r.name = n;
    r.team = t;
    return r;
  };

  const onMessage = (m: ServerMessage) => {
    if (m.t === WELCOME) {
      you = m.you;
      spawned = false;
      seq = 0;
      roster.clear();
      resetInterp(interp);
      for (const e of m.roster) if (isTeam(e.team)) robotFor(e.id, e.name, e.team);
    } else if (m.t === SNAPSHOT) {
      pushSnapshot(interp, m.tick, m.p, performance.now());
      const self = m.p.find((p) => p[0] === you);
      if (!self) return;
      if (!spawned) {
        resetPredictor(predictor, self[1], self[2], self[3], self[4]);
        snapCamera(cam, self[1], self[2]);
        spawned = true;
        acc = 0;
      } else reconcile(predictor, self[1], self[2], self[3], self[4], m.ack);
    } else if (m.t === EVENT) {
      if (m.kind === JOIN && typeof m.name === "string" && isTeam(m.team)) robotFor(m.id, m.name, m.team);
      else if (m.kind === LEAVE) roster.delete(m.id);
    }
  };

  const conn = connectArena(
    { name, team, player: playerId, touch: () => controls.touched || matchMedia("(pointer: coarse)").matches },
    {
      message: onMessage,
      status: (text) => {
        statusEl.hidden = text === null;
        if (text !== null) statusEl.textContent = text;
      },
      refused: (code) => {
        // The server's name rules refused the name (or the team): `/` asks for a new one.
        if (code === ERROR_NAME) setPlayerName(null);
        location.replace("/");
      },
    },
  );

  // Layout: the canvas at device resolution, the camera's view, the safe-area insets.
  const probe = document.createElement("div");
  probe.className = "safe-probe";
  document.body.appendChild(probe);
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    setViewport(cam, w, h);
    controls.width = w;
    const cs = getComputedStyle(probe);
    insets.top = parseFloat(cs.paddingTop) || 0;
    insets.right = parseFloat(cs.paddingRight) || 0;
    insets.bottom = parseFloat(cs.paddingBottom) || 0;
    insets.left = parseFloat(cs.paddingLeft) || 0;
    renderer.resize(w, h, dpr, cam, insets);
  };
  resize();
  window.addEventListener("resize", resize);

  // Input.
  let showStats = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === STATS_KEY && !e.repeat) showStats = !showStats;
    if (STEERING_KEYS.has(e.code)) {
      controls.keys.add(e.code);
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => controls.keys.delete(e.code));
  window.addEventListener("blur", () => releaseAll(controls));
  const local = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, kind: e.pointerType as PointerKind };
  };
  canvas.addEventListener("pointerdown", (e) => {
    const p = local(e);
    pointerDown(controls, p.kind, e.pointerId, p.x, p.y);
    if (p.kind === "touch") {
      try {
        canvas.setPointerCapture(e.pointerId); // keep the moves if a thumb slides off the canvas
      } catch {
        // Not capturable (synthetic events): the moves still arrive while over the canvas.
      }
    }
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    pointerMove(controls, p.kind, e.pointerId, p.x, p.y);
  });
  const end = (e: PointerEvent) => pointerUp(controls, e.pointerType as PointerKind, e.pointerId);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  /** Sends one input and predicts with it. */
  const sendInput = (mx: number, my: number, aim: number) => {
    const input: Input = clampInput({ seq: ++seq, mx, my, aim, fire: false, dash: false });
    conn.send(encodeInput(input));
    predictLocal(predictor, input);
  };
  // A hidden tab gets no frames: stop rather than repeat the last move until the server's stale limit.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && spawned) {
      releaseAll(controls);
      sendInput(0, 0, controls.aim);
    }
  });

  const read = { mx: 0, my: 0, aim: 0 };
  const self = { x: 0, y: 0 };
  const at = { x: 0, y: 0, aim: 0 };
  const meter = createFpsMeter();
  let statsReading = -1;
  let statsText = "";
  let acc = 0;
  let last = performance.now();
  const sticks = [controls.move, controls.aimStick];

  const frame = (now: number) => {
    const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
    last = now;
    if (tickFps(meter, dt)) statsReading = -1;

    if (spawned && conn.open) {
      acc += dt * 1000;
      let steps = 0;
      while (acc >= TICK_MS && steps < MAX_STEPS_PER_FRAME) {
        // Aim from your robot's spot on screen, where the player sees it.
        predictedAt(predictor, 1, self);
        readControls(controls, (self.x - cam.x) * cam.scale + cam.w * cam.scale / 2, (self.y - cam.y) * cam.scale + cam.h * cam.scale / 2, read);
        sendInput(read.mx, read.my, read.aim);
        acc -= TICK_MS;
        steps++;
      }
      if (acc >= TICK_MS) acc = 0;
    }
    decayCorrection(predictor, dt);

    // Who to draw: everyone in the newest snapshot, you predicted, the rest interpolated.
    drawn.length = 0;
    let selfIndex = -1;
    const rt = renderTick(interp, now);
    for (const row of newestPlayers(interp)) {
      const r = roster.get(row[0]);
      if (!r) continue;
      if (row[0] === you) {
        predictedAt(predictor, Math.min(1, acc / TICK_MS), self);
        r.x = self.x;
        r.y = self.y;
        r.aim = controls.aim;
        selfIndex = drawn.length;
      } else if (sample(interp, row[0], rt, at)) {
        r.x = at.x;
        r.y = at.y;
        r.aim = at.aim;
      } else continue;
      updateTrail(r.trail, r.x, r.y, dt);
      drawn.push(r);
    }
    if (selfIndex >= 0) followCamera(cam, drawn[selfIndex]!.x, drawn[selfIndex]!.y, dt);

    if (showStats && statsReading === -1) {
      statsReading = 0;
      statsText = `${Math.round(meter.fps)} fps · ${drawn.length} players`;
    }
    renderer.draw(cam, drawn, drawn.length, selfIndex, now / 1000, sticks, showStats ? statsText : null);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
