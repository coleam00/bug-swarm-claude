// The arena (release 2), plain TypeScript with no React in the loop. App.tsx mounts a canvas and
// calls `startArena` once the start screen has a name and a team: it joins an arena over the
// WebSocket and runs the frame loop: every local 50 ms step reads the controls, sends one input
// and predicts your robot with it; every frame draws you between predicted steps, everyone else and
// the bugs ~100 ms behind the server, every shot (yours at your own time, others' at theirs), the
// effects and the HUD line, with the camera following you. Space, Shift, the right mouse button or
// (on a touch screen) the dash button dash (predicted at once, like the move). When you go down
// you stop (no move, no fire, no dash, no prediction: you are drawn where the server has you)
// until someone revives you; when your life ends the server says so ("over") and App shows the
// life-over screen over the arena, which keeps playing behind it; its "Play again" calls
// `respawn()`, which sends the respawn press once RESTART_DELAY_MS has passed. `stop()` undoes
// everything `startArena` did: the frame loop, every listener, the probe and the socket, so a
// remount never leaves a second socket (each one's leaving would save a life).
import { DASH_COOLDOWN_TICKS, MAX_BUGS_PER_ARENA, TICK_MS } from "../../shared/arena/constants";
import {
  EVENT,
  JOIN,
  LEAVE,
  OVER,
  REVIVE,
  SNAPSHOT,
  WELCOME,
  encodeInput,
  type ErrorCode,
  type ServerMessage,
  type SnapshotDown,
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
import {
  DELAY_TICKS,
  bugSpan,
  createInterp,
  downAt,
  newestDown,
  newestPlayers,
  pushSnapshot,
  renderTick,
  resetInterp,
  sample,
  type BugSpan,
} from "./interp";
import { markUpdateReload } from "../player";
import { connectArena } from "./net";
import { createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor } from "./predict";
import { createArenaRenderer, type BugsView, type Robot, type Scene } from "./render";
import { addShot, clearKills, clearShots, createKillQueue, createShots, drainKills, endShot, pruneShots, queueKill } from "./shots";

/** Local steps one frame may run; a stalled tab drops the rest rather than burst inputs. */
const MAX_STEPS_PER_FRAME = 3;
/** Particles in a shot's spark (a kill bursts BURST_COUNT). */
const SPARK_COUNT = 5;

/** Who joins: the local player's id, name and team (player.ts). */
export type ArenaPlayer = { id: string; name: string; team: Team };

/** A life that ended, as the server scored it. */
export type LifeSummary = { score: number; kills: number; seconds: number };

/** What the arena tells the page around it. */
export type ArenaEvents = {
  /** "Connecting...", "Reconnecting...", "Updating...", "Reload to update", or null when playing. */
  status(text: string | null): void;
  /** The server refused the name (hidden, a bot name) or the team: the arena has stopped connecting. */
  refused(code: ErrorCode): void;
  /** Your life ended, at `at` (performance.now ms): "Play again" works from RESTART_DELAY_MS after it. */
  over(life: LifeSummary, at: number): void;
  /** You are in a life again (a respawn, or the new life a rejoin starts). */
  alive(): void;
  /** You are in a life for the first time since `startArena`. Once. */
  firstSpawn(): void;
};

export type ArenaHandle = {
  /** Asks for the next life; false (nothing sent) while not out or inside the restart guard. */
  respawn(): boolean;
  /** Stops everything startArena started. */
  stop(): void;
};

/** A touch screen's main pointer: the dash button shows. */
function coarsePointer(): boolean {
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

export function startArena(canvas: HTMLCanvasElement, player: ArenaPlayer, on: ArenaEvents): ArenaHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d canvas");
  const renderer = createArenaRenderer(ctx);
  const cam = createCamera(window.innerWidth, window.innerHeight);
  const controls = createControls(window.innerWidth);
  controls.dashButtonOn = coarsePointer();
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
  /** Down, waiting for a revive (still in the life: `alive` stays true). */
  let down = false;
  let seq = 0;
  let wave = 0;
  /** Your numbers from the last snapshot. */
  const me: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0 };
  let haveMe = false;
  /** Your last life's end, performance.now ms, until you are in a life again. */
  let overAt: number | null = null;
  let firstSpawned = false;
  let stopped = false;
  let raf = 0;

  const robotFor = (id: number, n: string, t: Team): Robot => {
    let r = roster.get(id);
    if (!r) {
      r = {
        id,
        x: 0,
        y: 0,
        aim: 0,
        name: n,
        team: t,
        trail: createTrail(),
        inv: false,
        prot: false,
        dashing: false,
        dashAt: -1,
        dashFromX: 0,
        dashFromY: 0,
        down: false,
        left: 0,
        rev: 0,
        revBy: 0,
      };
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
    // The life-over screen covers the canvas: a button or stick held now never sees its release.
    releaseAll(controls);
    on.over({ score, kills, seconds }, overAt);
  };

  const onMessage = (m: ServerMessage) => {
    if (m.t === WELCOME) {
      you = m.you;
      spawned = false;
      alive = false;
      down = false;
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
      pushSnapshot(interp, m.tick, m.p, performance.now(), m.b, m.d);
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
      const nowDown = m.me.dn === 1;
      if (!spawned || (nowAlive && !alive) || (down && nowAlive && !nowDown)) {
        // A join, a respawn or a revive: start predicting from where the server put you.
        resetPredictor(predictor, self[1], self[2], self[3], self[4], m.me.dk, m.me.dc);
        snapCamera(cam, self[1], self[2]);
        const r = roster.get(self[0]);
        if (r) r.trail.count = 0;
        spawned = true;
        acc = 0;
      } else if (nowAlive && !nowDown) reconcile(predictor, self[1], self[2], self[3], self[4], m.me.dk, m.me.dc, m.ack);
      const cameBack = nowAlive && !alive;
      alive = nowAlive;
      down = nowDown;
      if (cameBack) {
        overAt = null;
        if (!firstSpawned) {
          firstSpawned = true;
          on.firstSpawn();
        }
        on.alive();
      }
    } else if (m.t === EVENT) {
      if (m.kind === JOIN && typeof m.name === "string" && isTeam(m.team)) robotFor(m.id, m.name, m.team);
      else if (m.kind === LEAVE) roster.delete(m.id);
      else if (m.kind === OVER && m.id === you) lifeOver(m.score ?? 0, m.kills ?? 0, m.seconds ?? 0);
      else if (m.kind === REVIVE) {
        // Everyone sees the reviver's points float up over the robot they brought back.
        const r = roster.get(m.id);
        if (r && (m.points ?? 0) > 0) spawnText(texts, r.x, r.y, m.points);
      }
    }
  };

  const conn = connectArena(
    { name: player.name, team: player.team, player: player.id, touch: () => controls.touched || coarsePointer() },
    // A redeploy with a new build: load it and go straight back in (the life before was saved by
    // the server).
    {
      message: onMessage,
      status: on.status,
      refused: on.refused,
      newBuild: () => {
        markUpdateReload();
        location.reload();
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

  /** Out, and past the guard: a press now respawns you. */
  const canRespawn = () => spawned && !alive && overAt !== null && restartIn(overAt, performance.now()) === 0;

  // Input. Respawning is the life-over screen's (App.tsx, through `respawn()`), never a key here.
  let showStats = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === STATS_KEY && !e.repeat) showStats = !showStats;
    if (alive && DASH_KEYS.has(e.code) && !e.repeat) pressDash(controls);
    if (STEERING_KEYS.has(e.code)) {
      controls.keys.add(e.code);
      e.preventDefault();
    } else if (DASH_KEYS.has(e.code)) e.preventDefault(); // Space would scroll the page
  };
  const onKeyUp = (e: KeyboardEvent) => controls.keys.delete(e.code);
  const onBlur = () => releaseAll(controls);
  const local = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, kind: e.pointerType as PointerKind };
  };
  const onPointerDown = (e: PointerEvent) => {
    const p = local(e);
    pointerDown(controls, p.kind, e.pointerId, p.x, p.y, e.button, e.buttons);
    if (p.kind === "touch") {
      try {
        canvas.setPointerCapture(e.pointerId); // keep the moves if a thumb slides off the canvas
      } catch {
        // Not capturable (synthetic events): the moves still arrive while over the canvas.
      }
    }
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent) => {
    const p = local(e);
    pointerMove(controls, p.kind, e.pointerId, p.x, p.y, e.buttons);
  };
  const onPointerUp = (e: PointerEvent) => pointerUp(controls, e.pointerType as PointerKind, e.pointerId, e.buttons);
  const onContextMenu = (e: Event) => e.preventDefault();

  /**
   * Sends one input, and while up predicts with it. `dash` is the dash press while up and the
   * respawn press while out, when you send no move and no fire (and nothing is predicted: you are
   * not drawn, and the respawn resets the prediction). While down you send nothing that acts and
   * predict nothing (the server holds you still; the revive resets the prediction).
   */
  const sendInput = (mx: number, my: number, aim: number, fire: boolean, dash: boolean) => {
    const up = alive && !down;
    const input: Input = up
      ? clampInput({ seq: ++seq, mx, my, aim, fire, dash })
      : clampInput({ seq: ++seq, mx: 0, my: 0, aim, fire: false, dash: alive ? false : dash });
    conn.send(encodeInput(input));
    if (up) predictLocal(predictor, input);
  };
  // A hidden tab gets no frames: stop rather than repeat the last move until the server's stale limit.
  const onVisibility = () => {
    if (document.hidden && spawned) {
      releaseAll(controls);
      sendInput(0, 0, controls.aim, false, false);
    }
  };

  window.addEventListener("resize", resize);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("visibilitychange", onVisibility);

  const read = { mx: 0, my: 0, aim: 0, fire: false, dash: false, respawn: false };
  const self = { x: 0, y: 0 };
  const at = { x: 0, y: 0, aim: 0, alive: false, inv: false, dash: false, prot: false };
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
    players: 0,
    out: false,
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

  const setDown = (r: Robot, row: SnapshotDown | undefined) => {
    r.down = row !== undefined;
    r.left = row ? row[1] : 0;
    r.revBy = row ? row[2] : 0;
    r.rev = row ? row[3] : 0;
    if (r.down) r.trail.count = 0;
  };

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
    if (stopped) return;
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
        const dn = down ? newestDown(interp, row[0]) : undefined;
        if (dn) {
          // Down: where the server holds you, aim frozen.
          r.x = row[1];
          r.y = row[2];
          r.aim = row[5];
        } else {
          predictedAt(predictor, Math.min(1, acc / TICK_MS), self);
          // Your dash shows from your own step, not the server's echo.
          if (predictor.dashStart) startDash(r, self.x, self.y, now);
          predictor.dashStart = false;
          r.x = self.x;
          r.y = self.y;
          r.aim = controls.aim;
        }
        setDown(r, dn);
        r.inv = row[7] === 1;
        r.prot = row[9] === 1;
        r.dashing = !r.down && predictor.dashTicks > 0;
        selfIndex = drawn.length;
      } else if (sample(interp, row[0], rt, at) && at.alive) {
        if (at.dash && !r.dashing) startDash(r, at.x, at.y, now);
        r.dashing = at.dash;
        r.x = at.x;
        r.y = at.y;
        r.aim = at.aim;
        r.inv = at.inv;
        r.prot = at.prot;
        setDown(r, downAt(interp, row[0], rt));
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
    scene.players = roster.size;
    scene.out = spawned && !alive;
    scene.stats = showStats ? statsText : null;
    scene.dashButton = controls.dashButtonOn && alive && selfIndex >= 0 ? controls.dashButton : null;
    scene.dashReady = 1 - predictor.dashCooldown / DASH_COOLDOWN_TICKS;
    renderer.draw(cam, scene);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    respawn() {
      if (stopped || !canRespawn()) return false;
      pressRespawn(controls);
      return true;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("visibilitychange", onVisibility);
      probe.remove();
      conn.close();
    },
  };
}
