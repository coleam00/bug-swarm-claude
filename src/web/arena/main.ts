// The /arena page (release 2): plain TypeScript, no React. With a name and a team (the same
// local player `/` keeps; without them, `/` asks first), it joins an arena over the WebSocket and
// runs the frame loop: every local 50 ms step reads the controls, sends one input and predicts
// your robot with it; every frame draws you between predicted steps, everyone else and the bugs
// ~100 ms behind the server, every shot (yours at your own time, others' at theirs), the effects
// and the HUD, with the camera following you. Space, Shift, the right mouse button or the dash
// button dash (predicted at once, like the move). When your life ends the server says so ("over"),
// and after RESTART_DELAY_MS any key, click or tap sends the respawn press.
import { DASH_COOLDOWN_TICKS, MAX_BUGS_PER_ARENA, TICK_MS } from "../../shared/arena/constants";
import {
  ERROR_NAME,
  EVENT,
  JOIN,
  LEAVE,
  OVER,
  SNAPSHOT,
  WELCOME,
  encodeInput,
  type ServerMessage,
  type SnapshotMe,
} from "../../shared/arena/protocol";
import { clampInput, type Input } from "../../shared/arena/sim";
import { isTeam, type Team } from "../../server/rules";
import { createFpsMeter, tickFps } from "../game/fps";
import { BURST_COUNT, createParticles, spawnBurst, updateParticles } from "../game/fx/particles";
import { HIT_SHAKE, createShake, kick, updateShake } from "../game/fx/shake";
import { createTexts, setTextScale, spawnText, updateTexts } from "../game/fx/text";
import { createTrail, updateTrail } from "../game/fx/trail";
import { restartIn } from "../game/guard";
import type { Insets } from "../game/hud";
import { STATS_KEY, STEERING_KEYS } from "../game/keys";
import { BUG_LOOKS, GLOW_SHOT } from "../game/look";
import { createRng } from "../game/rng";
import { loadPlayer, nextScreen, noteArenaRefusedName } from "../player";
import { createCamera, followCamera, setViewport, snapCamera } from "./camera";
import {
  DASH_KEYS,
  createControls,
  dashButtonAt,
  pointerDown,
  pointerMove,
  pointerUp,
  pressDash,
  pressRespawn,
  readControls,
  releaseAll,
  type PointerKind,
} from "./controls";
import { createHudFx, noteMe, resetHudFx, updateHudFx } from "./hudfx";
import { DELAY_TICKS, bugSpan, createInterp, newestPlayers, pushSnapshot, renderTick, resetInterp, sample, type BugSpan } from "./interp";
import { connectArena } from "./net";
import { createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor } from "./predict";
import { createArenaRenderer, type BugsView, type OverView, type Robot, type Scene } from "./render";
import { addShot, clearKills, clearShots, createKillQueue, createShots, drainKills, endShot, pruneShots, queueKill } from "./shots";

/** Local steps one frame may run; a stalled tab drops the rest rather than burst inputs. */
const MAX_STEPS_PER_FRAME = 3;
/** Particles in a shot's spark (a kill bursts BURST_COUNT). */
const SPARK_COUNT = 5;

const player = loadPlayer();
if (nextScreen(player, false, false) !== "play" || player.name === null || player.team === null) {
  location.replace("/");
} else {
  start(player.id, player.name, player.team);
}

function formatSeconds(s: number): string {
  const whole = Math.floor(s);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
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
  const shots = createShots();
  const kills = createKillQueue();
  const particles = createParticles();
  const texts = createTexts();
  const shake = createShake();
  const hudFx = createHudFx();
  // Effects draw from their own generator, never the simulation's.
  const fxRng = createRng(Date.now() | 0);
  const killGlow = BUG_LOOKS.base.glow;

  // Who is in the arena: names and teams come once, in the welcome and in join events.
  const roster = new Map<number, Robot>();
  /** The robots drawn this frame, reused. */
  const drawn: Robot[] = [];
  let you: number | null = null;
  let spawned = false;
  let alive = false;
  let seq = 0;
  let wave = 0;
  /** Your numbers from the last snapshot. */
  const me: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0 };
  let haveMe = false;
  /** Your last life's end: when (performance.now ms) and what to show. */
  let overAt: number | null = null;
  const over: OverView = { title: "Life over", score: "", line: "", prompt: "Tap or press any key", ready: false };

  const robotFor = (id: number, n: string, t: Team): Robot => {
    let r = roster.get(id);
    if (!r) {
      r = { id, x: 0, y: 0, aim: 0, name: n, team: t, trail: createTrail(), inv: false, dashing: false, dashAt: -1, dashFromX: 0, dashFromY: 0 };
      roster.set(id, r);
    }
    r.name = n;
    r.team = t;
    return r;
  };

  const isMine = (owner: number) => owner === you;
  const spark = (x: number, y: number) => spawnBurst(particles, x, y, SPARK_COUNT, GLOW_SHOT, fxRng);
  const showKill = (x: number, y: number, points: number) => {
    spawnBurst(particles, x, y, BURST_COUNT, killGlow, fxRng);
    if (points > 0) spawnText(texts, x, y, points);
  };

  const lifeOver = (score: number, kills: number, seconds: number) => {
    overAt = performance.now();
    over.score = `${score.toLocaleString("en-US")} points`;
    over.line = `${kills} ${kills === 1 ? "kill" : "kills"} · ${formatSeconds(seconds)}`;
    over.ready = false;
  };

  const onMessage = (m: ServerMessage) => {
    if (m.t === WELCOME) {
      you = m.you;
      spawned = false;
      alive = false;
      haveMe = false;
      overAt = null;
      seq = 0;
      roster.clear();
      resetInterp(interp);
      clearShots(shots);
      clearKills(kills);
      resetHudFx(hudFx);
      for (const e of m.roster) if (isTeam(e.team)) robotFor(e.id, e.name, e.team);
    } else if (m.t === SNAPSHOT) {
      pushSnapshot(interp, m.tick, m.p, performance.now(), m.b);
      wave = m.w;
      for (const s of m.s) addShot(shots, s[0], s[1], s[2], s[3], s[4], m.tick);
      for (const e of m.e) endShot(shots, e[0], e[1] === 1, e[2], m.tick);
      for (const k of m.k) queueKill(kills, m.tick, k[2], k[3], k[4], k[1]);
      Object.assign(me, m.me);
      haveMe = true;
      if (noteMe(hudFx, m.me)) kick(shake, HIT_SHAKE);
      const self = m.p.find((p) => p[0] === you);
      if (!self) return;
      const nowAlive = m.me.al === 1;
      if (!spawned || (nowAlive && !alive)) {
        // A join or a respawn: start predicting from where the server put you.
        resetPredictor(predictor, self[1], self[2], self[3], self[4], m.me.dk, m.me.dc);
        snapCamera(cam, self[1], self[2]);
        const r = roster.get(self[0]);
        if (r) r.trail.count = 0;
        spawned = true;
        acc = 0;
        if (nowAlive) overAt = null;
      } else if (nowAlive) reconcile(predictor, self[1], self[2], self[3], self[4], m.me.dk, m.me.dc, m.ack);
      alive = nowAlive;
    } else if (m.t === EVENT) {
      if (m.kind === JOIN && typeof m.name === "string" && isTeam(m.team)) robotFor(m.id, m.name, m.team);
      else if (m.kind === LEAVE) roster.delete(m.id);
      else if (m.kind === OVER && m.id === you) lifeOver(m.score ?? 0, m.kills ?? 0, m.seconds ?? 0);
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
        // The server refused the name (a "bot ..." name, which `/` still accepts) or the team:
        // `/` keeps the name and says why on its start screen.
        if (code === ERROR_NAME) noteArenaRefusedName(name);
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
    setTextScale(texts, cam.scale);
    controls.width = w;
    const cs = getComputedStyle(probe);
    insets.top = parseFloat(cs.paddingTop) || 0;
    insets.right = parseFloat(cs.paddingRight) || 0;
    insets.bottom = parseFloat(cs.paddingBottom) || 0;
    insets.left = parseFloat(cs.paddingLeft) || 0;
    dashButtonAt(w, h, insets, controls.dashButton);
    renderer.resize(w, h, dpr, cam, insets);
  };
  resize();
  window.addEventListener("resize", resize);

  /** Out, and past the guard: a press now respawns you. */
  const canRespawn = () => spawned && !alive && overAt !== null && restartIn(overAt, performance.now()) === 0;

  // Input.
  let showStats = false;
  window.addEventListener("keydown", (e) => {
    if (e.code === STATS_KEY && !e.repeat) showStats = !showStats;
    else if (canRespawn() && !e.repeat) pressRespawn(controls);
    if (alive && DASH_KEYS.has(e.code) && !e.repeat) pressDash(controls);
    if (STEERING_KEYS.has(e.code)) {
      controls.keys.add(e.code);
      e.preventDefault();
    } else if (DASH_KEYS.has(e.code)) e.preventDefault(); // Space would scroll the page
  });
  window.addEventListener("keyup", (e) => controls.keys.delete(e.code));
  window.addEventListener("blur", () => releaseAll(controls));
  const local = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, kind: e.pointerType as PointerKind };
  };
  canvas.addEventListener("pointerdown", (e) => {
    const p = local(e);
    if (canRespawn()) pressRespawn(controls);
    pointerDown(controls, p.kind, e.pointerId, p.x, p.y, e.button);
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
  const end = (e: PointerEvent) => pointerUp(controls, e.pointerType as PointerKind, e.pointerId, e.button);
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  /**
   * Sends one input, and while alive predicts with it. `dash` is the dash press while alive and
   * the respawn press while out, when you send no move and no fire (and nothing is predicted: you
   * are not drawn, and the respawn resets the prediction).
   */
  const sendInput = (mx: number, my: number, aim: number, fire: boolean, dash: boolean) => {
    const input: Input = alive
      ? clampInput({ seq: ++seq, mx, my, aim, fire, dash })
      : clampInput({ seq: ++seq, mx: 0, my: 0, aim, fire: false, dash });
    conn.send(encodeInput(input));
    if (alive) predictLocal(predictor, input);
  };
  // A hidden tab gets no frames: stop rather than repeat the last move until the server's stale limit.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && spawned) {
      releaseAll(controls);
      sendInput(0, 0, controls.aim, false, false);
    }
  });

  const read = { mx: 0, my: 0, aim: 0, fire: false, dash: false, respawn: false };
  const self = { x: 0, y: 0 };
  const at = { x: 0, y: 0, aim: 0, alive: false, inv: false, dash: false };
  const span: BugSpan = { from: null, to: null, t: 0 };
  const bugs: BugsView = {
    x: new Float32Array(MAX_BUGS_PER_ARENA),
    y: new Float32Array(MAX_BUGS_PER_ARENA),
    heading: new Float32Array(MAX_BUGS_PER_ARENA),
    phase: new Float32Array(MAX_BUGS_PER_ARENA),
    kind: new Uint8Array(MAX_BUGS_PER_ARENA),
    count: 0,
  };
  /** Each bug's last heading, so a bug standing still keeps facing where it was going. */
  const headings = new Map<number, number>();
  const scene: Scene = {
    robots: drawn,
    count: 0,
    self: -1,
    t: 0,
    bugs,
    shots,
    mineAt: 0,
    othersAt: 0,
    you: null,
    particles,
    texts,
    shake,
    me: null,
    wave: 0,
    hud: hudFx,
    over: null,
    sticks: [controls.move, controls.aimStick],
    stats: null,
    dashButton: null,
    dashReady: 1,
  };
  const meter = createFpsMeter();
  let statsReading = -1;
  let statsText = "";
  let acc = 0;
  let last = performance.now();

  /**
   * A robot's dash began this frame: its afterimage runs from where it was last drawn (or `x, y`
   * when it was not drawn last frame) to wherever it is now.
   */
  const startDash = (r: Robot, x: number, y: number, now: number) => {
    const seen = r.trail.count > 0;
    r.dashFromX = seen ? r.x : x;
    r.dashFromY = seen ? r.y : y;
    r.dashAt = now / 1000;
  };

  const fillBugs = (rt: number) => {
    bugSpan(interp, rt, span);
    bugs.count = 0;
    const from = span.from;
    if (!from) return;
    for (const row of from.b) {
      if (bugs.count >= MAX_BUGS_PER_ARENA) break;
      const id = row[0];
      const next = span.to?.bi.get(id);
      let x = row[2];
      let y = row[3];
      let heading = headings.get(id) ?? 0;
      if (next) {
        const dx = next[2] - row[2];
        const dy = next[3] - row[3];
        x += dx * span.t;
        y += dy * span.t;
        if (dx * dx + dy * dy > 0.01) {
          heading = Math.atan2(dy, dx);
          headings.set(id, heading);
        }
      }
      const i = bugs.count++;
      bugs.x[i] = x;
      bugs.y[i] = y;
      bugs.heading[i] = heading;
      bugs.phase[i] = (id * 0.618) % 1;
      bugs.kind[i] = row[1];
    }
    // Forget the headings of bugs long gone.
    if (headings.size > MAX_BUGS_PER_ARENA * 2) headings.clear();
  };

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
        readControls(controls, (self.x - cam.x) * cam.scale + (cam.w * cam.scale) / 2, (self.y - cam.y) * cam.scale + (cam.h * cam.scale) / 2, read);
        sendInput(read.mx, read.my, read.aim, read.fire, alive ? read.dash : read.respawn);
        acc -= TICK_MS;
        steps++;
      }
      if (acc >= TICK_MS) acc = 0;
    }
    decayCorrection(predictor, dt);
    over.ready = overAt !== null && restartIn(overAt, now) === 0;

    // The clocks: everyone else 100 ms behind the server, you and your shots at the server's now.
    const rt = renderTick(interp, now);
    const mineAt = rt + DELAY_TICKS;
    pruneShots(shots, mineAt, isMine, true, spark);
    pruneShots(shots, rt, isMine, false, spark);
    drainKills(kills, mineAt, isMine, true, showKill);
    drainKills(kills, rt, isMine, false, showKill);
    updateParticles(particles, dt);
    updateTexts(texts, dt);
    updateShake(shake, dt, fxRng);
    updateHudFx(hudFx, dt);

    // Who to draw: everyone in a life in the newest snapshot, you predicted, the rest interpolated.
    drawn.length = 0;
    let selfIndex = -1;
    for (const row of newestPlayers(interp)) {
      const r = roster.get(row[0]);
      if (!r) continue;
      if (row[0] === you) {
        if (!alive) {
          r.trail.count = 0; // no streak across the map on the respawn
          continue;
        }
        predictedAt(predictor, Math.min(1, acc / TICK_MS), self);
        // Your dash shows from your own step, not the server's echo.
        if (predictor.dashStart) startDash(r, self.x, self.y, now);
        predictor.dashStart = false;
        r.x = self.x;
        r.y = self.y;
        r.aim = controls.aim;
        r.inv = row[7] === 1;
        r.dashing = predictor.dashTicks > 0;
        selfIndex = drawn.length;
      } else if (sample(interp, row[0], rt, at) && at.alive) {
        if (at.dash && !r.dashing) startDash(r, at.x, at.y, now);
        r.dashing = at.dash;
        r.x = at.x;
        r.y = at.y;
        r.aim = at.aim;
        r.inv = at.inv;
      } else {
        r.dashing = false;
        r.trail.count = 0;
        continue;
      }
      updateTrail(r.trail, r.x, r.y, dt);
      drawn.push(r);
    }
    if (selfIndex >= 0) followCamera(cam, drawn[selfIndex]!.x, drawn[selfIndex]!.y, dt);
    fillBugs(rt);

    if (showStats && statsReading === -1) {
      statsReading = 0;
      statsText = `${Math.round(meter.fps)} fps · ${drawn.length} players · ${bugs.count} bugs · ${shots.live} shots · ${particles.live} fx`;
    }
    scene.count = drawn.length;
    scene.self = selfIndex;
    scene.t = now / 1000;
    scene.mineAt = mineAt;
    scene.othersAt = rt;
    scene.you = you;
    scene.me = haveMe ? me : null;
    scene.wave = wave;
    scene.over = overAt !== null && !alive ? over : null;
    scene.stats = showStats ? statsText : null;
    scene.dashButton = alive && selfIndex >= 0 ? controls.dashButton : null;
    scene.dashReady = 1 - predictor.dashCooldown / DASH_COOLDOWN_TICKS;
    renderer.draw(cam, scene);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
