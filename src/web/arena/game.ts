// The arena (release 2), plain TypeScript with no React in the loop. App.tsx mounts a canvas and
// calls `startArena` once the start screen has a name (and the stored team, if any): it joins an arena over the
// WebSocket and runs the frame loop: every local 50 ms step reads the controls, sends one input
// and predicts your robot with it; every frame draws you between predicted steps, everyone else and
// the bugs ~100 ms behind the server, every shot (yours at your own time, others' at theirs), the
// effects and the HUD line, with the camera following you. Space, Shift, the right mouse button or
// (on a touch screen) the dash button dash (predicted at once, like the move); Q, E or the grenade
// button throw a grenade (#130: not predicted; its `grenade` event draws it for everyone, grenades.ts). When you go down
// you stop (no move, no fire, no dash, no prediction: you are drawn where the server has you)
// until someone revives you; when your life ends the server says so ("over") and App shows the
// life-over screen over the arena, which keeps playing behind it; its "Play again" calls
// `respawn()`, which sends the respawn press once RESTART_DELAY_MS has passed. `stop()` undoes
// everything `startArena` did: the frame loop, every listener, the probe and the socket, so a
// remount never leaves a second socket (each one's leaving would end a life).
// Pickups (#73): the floor comes in each snapshot's `f` and is drawn with the bugs; a `pickup`
// event floats the pickup's label over whoever took it (and a refactor bomb's ring goes out from
// them, #78), and a `block` event pops their shield.
// The hive queen (#85): each snapshot's `q` (her marker, or her health) is kept for the renderer;
// her `queen` event bursts where she died, floats each reward over its robot and shows "Queen
// down!" naming who dealt the most (her kill row itself scores no points, so floats nothing).
// Watching (#79): `startWatch` runs the same arena for the start screen with no robot of its own:
// a watch connection (net.ts watchArena), no input listeners at all (the name field keeps its
// keys), no HUD, a camera that drifts between the action (drift.ts), and a backing store at most
// 1x (it is drawn blurred). `handoff()` stops it and hands its open connection to startArena,
// which plays on the same socket.
// Stream scale (#89): snapshots carry only the bugs near you; the minimap's far swarm comes once a
// second as cells (`m`). The F readout adds the KB/s the socket receives and the p95 time from an
// input leaving to a snapshot acknowledging it (netmeter.ts).
// Hidden tabs (#117): the page tells the server whenever its tab is hidden or shown, and after every
// player welcome on a hidden page, so a hidden player stops counting as a person. A player out long
// enough may be moved out of the arena to free a slot: the page then gets a leave for its own robot
// and the arena's watcher stream (your numbers are kept from your last own snapshot), and its
// "Play again" press comes back with a fresh welcome, maybe in another arena.
import { BUG_KINDS, DASH_COOLDOWN_TICKS, DT, GRENADE_COOLDOWN_TICKS, MAX_BUGS_PER_ARENA, MAX_PICKUPS_PER_ARENA, PICKUP_IDS, TICK_MS } from "../../shared/arena/constants";

/** Bugs a snapshot can carry: the arena's cap, plus a hive queen, who is placed whatever the count (#85). */
const BUG_SLOTS = MAX_BUGS_PER_ARENA + 1;
import { BOMB_RADIUS, bomb } from "../../shared/arena/pickups/bomb";
import { PICKUP_LABELS } from "../../shared/arena/pickups/registry";
import {
  BLOCK,
  GRENADE,
  EVENT,
  GOLDEN,
  JOIN,
  LEAVE,
  OVER,
  PICKUP,
  QUEEN,
  REVIVE,
  SNAPSHOT,
  WELCOME,
  encodeInput,
  encodeVisibility,
  type ErrorCode,
  type ServerMessage,
  type SnapshotDown,
  type SnapshotMe,
  type SnapshotGolden,
  type SnapshotQueen,
} from "../../shared/arena/protocol";
import { clampInput, wrapAngle, type Input } from "../../shared/arena/sim";
import { isTeam, type Team } from "../../server/rules";
import { createFpsMeter, tickFps } from "../game/fps";
import { ackP95, createNetMeter, noteAck, noteSent, readKbps, resetNetMeter } from "./netmeter";
import { BURST_COUNT, createParticles, spawnBurst, updateParticles } from "../game/fx/particles";
import { createRings, spawnRing, updateRings } from "../game/fx/rings";
import { HIT_SHAKE, createShake, kick, updateShake } from "../game/fx/shake";
import { TEXT_CAPACITY, createTexts, setTextScale, spawnText, spawnWord, updateTexts } from "../game/fx/text";
import { createTrail, updateTrail } from "../game/fx/trail";
import { restartIn } from "../game/guard";
import type { Insets } from "../game/hud";
import { STATS_KEY, STEERING_KEYS } from "../game/keys";
import { GLOW_AMBER, GLOW_GOLD, GLOW_QUEEN, GLOW_SHIELD, GLOW_SHOT, GLOW_STEEL, GLOW_WHITE } from "../game/look";
import { createRng } from "../game/rng";
import { createCamera, followCamera, setViewport, snapCamera } from "./camera";
import { createDrift, stepDrift } from "./drift";
import { BUG_DRAW } from "./draw/bugs";
import { PICKUP_DRAW } from "./draw/pickups";
import {
  DASH_KEYS,
  createControls,
  dashButtonAt,
  grenadeButtonAt,
  GRENADE_KEYS,
  pointerDown,
  pointerMove,
  pointerUp,
  pressDash,
  pressGrenade,
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
  easeHeading,
  pushSnapshot,
  renderTick,
  resetInterp,
  sample,
  type BugSpan,
} from "./interp";
import { markUpdateReload } from "../player";
import { connectArena, watchArena, type Connection, type PlayHandlers, type WatchConnection } from "./net";
import { createPredictor, decayCorrection, predictLocal, predictedAt, reconcile, resetPredictor } from "./predict";
import { createBanner, goldenBannerText, showBanner, updateBanner } from "./queenhud";
import { createArenaRenderer, type BugsView, type FloorView, type Robot, type Scene } from "./render";
import { addShot, clearKills, clearShots, createKillQueue, createShots, drainKills, endShot, pruneShots, queueKill } from "./shots";
import { countPeople, isBot } from "./tag";
import { createTings, spawnTing, updateTings } from "./tings";
import { addGrenade, clearGrenades, createGrenades, stepGrenadeFx } from "./grenades";

/** Local steps one frame may run; a stalled tab drops the rest rather than burst inputs. */
const MAX_STEPS_PER_FRAME = 3;
/** Particles in a shot's spark (a kill bursts BURST_COUNT). */
const SPARK_COUNT = 5;
/** Particles in the spark off a beetle's shell (#80), in steel and in white. */
const BLOCK_STEEL = 6;
/** A grenade's blast shakes your screen this much (#130), when your camera is this near it, world units. */
const GRENADE_SHAKE = 6;
const GRENADE_SHAKE_NEAR = 300;
const BLOCK_WHITE = 3;
/** A pickup's label floats up from this far above the robot that took it, world units (#73). */
const LABEL_ABOVE = 46;

/**
 * Who joins: the local player's id, name and stored team (player.ts), or null for none: the
 * server picks one and the welcome says which (#131, ArenaEvents.team).
 */
export type ArenaPlayer = { id: string; name: string; team: Team | null };

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
  /** Your team, as the server decided it: on every player welcome (#131). */
  team(team: Team): void;
  /**
   * A golden bug was killed in your arena (#122): its banner's text. The canvas draws it while you
   * are in a life; the life-over screen, over the canvas, shows it itself (App.tsx).
   */
  golden(text: string): void;
};

export type ArenaHandle = {
  /** Asks for the next life; false (nothing sent) while not out or inside the restart guard. */
  respawn(): boolean;
  /** Stops everything startArena started. */
  stop(): void;
};

/** What the watched arena tells the start screen. */
export type WatchEvents = {
  /** True on the first snapshot after a welcome (the arena is on screen); false when the connection drops. */
  live(on: boolean): void;
  /** The server will not take a watcher (its cap, or another version): nothing reconnects. */
  unavailable(): void;
  /** A golden bug was killed in the watched arena (#122): its banner's text, which the start screen shows (App.tsx). */
  golden(text: string): void;
};

export type WatchHandle = {
  /**
   * Stops the view and hands over its connection, still open, for startArena to play on; null
   * (closed) when it is not open.
   */
  handoff(): WatchConnection | null;
  /** Stops everything startWatch started, the connection included unless handed off. */
  stop(): void;
};

/** Each watched frame's cost (interpolation, effects and draw) in ms, a ring of the last COST_FRAMES. Dev server only. */
export type WatchRecord = { work: Float64Array; count: number };

declare global {
  interface Window {
    bugSwarmWatch?: WatchRecord;
  }
}

const COST_FRAMES = 3600;

type Mode =
  | { watch: false; player: ArenaPlayer; on: ArenaEvents; adopt: WatchConnection | null }
  | { watch: true; on: WatchEvents };

/** A touch screen's main pointer: the dash button shows. */
function coarsePointer(): boolean {
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * Joins and plays. `adopt` is the start screen's watching connection (WatchHandle.handoff): the
 * hello goes on it rather than on a new socket.
 */
export function startArena(canvas: HTMLCanvasElement, player: ArenaPlayer, on: ArenaEvents, adopt: WatchConnection | null = null): ArenaHandle {
  const run = runArena(canvas, { watch: false, player, on, adopt });
  return { respawn: run.respawn, stop: run.stop };
}

/** Watches an arena behind the start screen (#79). */
export function startWatch(canvas: HTMLCanvasElement, on: WatchEvents): WatchHandle {
  const run = runArena(canvas, { watch: true, on });
  return { handoff: run.handoff, stop: run.stop };
}

function runArena(canvas: HTMLCanvasElement, mode: Mode) {
  const watch = mode.watch;
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
  // Refactor bombs going off (#78).
  const rings = createRings();
  // Score labels, and each pickup's word label (#73), built once.
  const texts = createTexts(TEXT_CAPACITY, PICKUP_LABELS);
  const tings = createTings();
  const shake = createShake();
  // Grenades thrown (#130).
  const grenades = createGrenades();
  const hudFx = createHudFx();
  // Effects draw from their own generator, never the simulation's.
  const fxRng = createRng(Date.now() | 0);
  // A kill bursts in its kind's glow, by its index in BUG_KINDS.
  const killGlows = BUG_KINDS.map((k) => BUG_DRAW[k].look.glow);
  // The hive queen (#85): the newest snapshot's `q`, and "Queen down!" with its name.
  const noQueen: SnapshotQueen = [];
  let queenQ: SnapshotQueen = noQueen;
  const banner = createBanner();
  let bannerName = "";
  // The golden bug (#122): the newest snapshot's `g` (its minimap dot and edge arrow), and
  // "<name> got the golden bug!" on every page in the arena.
  const noGolden: SnapshotGolden = [];
  let goldenG: SnapshotGolden = noGolden;
  const goldBanner = createBanner();
  let goldName = "";

  // Who is in the arena: names and teams come once, in the welcome and in join events.
  const roster = new Map<number, Robot>();
  /** The people in the roster, bots never counted (#90): the HUD's "N playing". Recounted only when the roster changes. */
  let people = 0;
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
  const me: SnapshotMe = { sc: 0, ki: 0, st: 0, mu: 1, he: 0, lk: 0, hl: 0, al: 0, dk: 0, dc: 0, dn: 0, fx: [], x: 0, y: 0, vx: 0, vy: 0, gc: 0 };
  /** The minimap's bugs outside your view, as cells (the last keyframe's `m`). */
  let far: number[] = [];
  const net = createNetMeter();
  let haveMe = false;
  /** Your last life's end, performance.now ms, until you are in a life again. */
  let overAt: number | null = null;
  let firstSpawned = false;
  let stopped = false;
  let raf = 0;
  /** Watching: on screen since the last welcome; and the camera's next frame jumps to its first focus. */
  let live = false;
  let snapNext = true;
  const drift = createDrift();

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
        bot: false,
        tag: { x: 0, w: 0 },
        fx: 0,
      };
      roster.set(id, r);
    }
    if (r.name !== n) r.tag.w = 0;
    r.bot = isBot(n);
    r.name = n;
    r.team = t;
    return r;
  };

  const isMine = (owner: number) => owner === you;
  const spark = (x: number, y: number, blocked: boolean) => {
    if (!blocked) return spawnBurst(particles, x, y, SPARK_COUNT, GLOW_SHOT, fxRng);
    // A shell blocked it (#80): a steel-white spark and a ting, never the yellow of a hit.
    spawnBurst(particles, x, y, BLOCK_STEEL, GLOW_STEEL, fxRng);
    spawnBurst(particles, x, y, BLOCK_WHITE, GLOW_WHITE, fxRng);
    spawnTing(tings, x, y);
  };
  /** A grenade going off (#130): a burst of fire at its landing point, and a small shake when your camera is near it. */
  const grenadeBlast = (x: number, y: number) => {
    spawnBurst(particles, x, y, BURST_COUNT * 2, GLOW_AMBER, fxRng);
    spawnBurst(particles, x, y, BURST_COUNT, GLOW_WHITE, fxRng);
    if ((cam.x - x) ** 2 + (cam.y - y) ** 2 <= GRENADE_SHAKE_NEAR * GRENADE_SHAKE_NEAR) kick(shake, GRENADE_SHAKE);
  };
  const showKill = (x: number, y: number, points: number, _by: number, kind: number) => {
    spawnBurst(particles, x, y, BURST_COUNT, killGlows[kind] ?? killGlows[0]!, fxRng);
    if (points > 0) spawnText(texts, x, y, points);
  };

  const lifeOver = (score: number, kills: number, seconds: number) => {
    overAt = performance.now();
    // The life-over screen covers the canvas: a button or stick held now never sees its release.
    releaseAll(controls);
    if (!mode.watch) mode.on.over({ score, kills, seconds }, overAt);
  };

  const setLive = (on: boolean) => {
    if (live === on || !mode.watch) return;
    live = on;
    mode.on.live(on);
  };

  const onMessage = (m: ServerMessage) => {
    if (m.t === WELCOME) {
      // Watching, you is 0: no robot is yours (a kill `by` 0 is nobody's, never yours).
      you = m.you === 0 ? null : m.you;
      snapNext = true;
      spawned = false;
      alive = false;
      down = false;
      haveMe = false;
      overAt = null;
      seq = 0;
      far = [];
      resetNetMeter(net);
      roster.clear();
      resetInterp(interp);
      clearShots(shots);
      clearKills(kills);
      clearGrenades(grenades);
      resetHudFx(hudFx);
      queenQ = noQueen;
      goldenG = noGolden;
      banner.left = 0;
      goldBanner.left = 0;
      for (const e of m.roster) if (isTeam(e.team)) robotFor(e.id, e.name, e.team);
      people = countPeople(roster.values());
      // A new socket or arena counts you as shown until told otherwise.
      if (you !== null && document.hidden) conn.send(encodeVisibility(true));
    } else if (m.t === SNAPSHOT) {
      pushSnapshot(interp, m.tick, m.p, performance.now(), m.b, m.d, m.f);
      wave = m.w;
      queenQ = m.q ?? noQueen;
      goldenG = m.g ?? noGolden;
      if (m.m) far = m.m;
      noteAck(net, m.ack, performance.now());
      for (const s of m.s) addShot(shots, s[0], s[1], s[2], s[3], s[4], m.tick, s[5]);
      for (const e of m.e) endShot(shots, e[0], e[1], e[2], m.tick);
      for (const k of m.k) queueKill(kills, m.tick, k[2], k[3], k[4], k[1], k[5] ?? 0);
      if (watch) return setLive(true);
      // Moved out of the arena (#117), you get the watchers' snapshots: no row of yours, numbers zeroed.
      const self = m.p.find((p) => p[0] === you);
      if (!self) return;
      Object.assign(me, m.me);
      haveMe = true;
      if (noteMe(hudFx, m.me)) kick(shake, HIT_SHAKE);
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
      if (cameBack && !mode.watch) {
        overAt = null;
        if (!firstSpawned) {
          firstSpawned = true;
          mode.on.firstSpawn();
        }
        mode.on.alive();
      }
    } else if (m.t === EVENT) {
      if (m.kind === JOIN && typeof m.name === "string" && isTeam(m.team)) {
        robotFor(m.id, m.name, m.team);
        people = countPeople(roster.values());
      } else if (m.kind === LEAVE) {
        roster.delete(m.id);
        people = countPeople(roster.values());
      } else if (m.kind === OVER && m.id === you) lifeOver(m.score ?? 0, m.kills ?? 0, m.seconds ?? 0);
      else if (m.kind === REVIVE) {
        // Everyone sees the reviver's points float up over the robot they brought back.
        const r = roster.get(m.id);
        if (r && (m.points ?? 0) > 0) spawnText(texts, r.x, r.y, m.points);
      } else if (m.kind === PICKUP) {
        // Everyone sees what was taken: its label over the robot that took it, and a burst in its glow.
        const r = roster.get(m.id);
        const id = PICKUP_IDS[m.pickup ?? -1];
        if (r && id) {
          spawnWord(texts, r.x, r.y - LABEL_ABOVE, m.pickup!);
          spawnBurst(particles, r.x, r.y, SPARK_COUNT * 2, PICKUP_DRAW[id].glow, fxRng);
          // A refactor bomb goes off at the take: its ring sweeps out from the taker (your own
          // robot is where you see it, predicted), its kills arriving as ordinary kill rows.
          if (id === bomb.id) spawnRing(rings, r.x, r.y, BOMB_RADIUS);
        }
      } else if (m.kind === GRENADE && m.gr) {
        // A grenade thrown (#130): every page draws its flight, blink ring and blast from this.
        addGrenade(grenades, m.id, m.gr);
      } else if (m.kind === BLOCK) {
        // A shield blocked a hit: the bubble pops, for everyone.
        const r = roster.get(m.id);
        if (r) spawnBurst(particles, r.x, r.y, BURST_COUNT, GLOW_SHIELD, fxRng);
      } else if (m.kind === QUEEN) {
        // The hive queen is down: a big burst where she was last seen, each reward over its robot,
        // and the banner naming who dealt the most (drawn as canvas text, never HTML).
        const q = queenQ;
        if (q.length > 0 && q[0] === 1) for (let i = 0; i < 3; i++) spawnBurst(particles, q[2], q[3], BURST_COUNT, GLOW_QUEEN, fxRng);
        for (const [id, points] of m.paid ?? []) {
          const r = roster.get(id);
          if (r && points > 0) spawnText(texts, r.x, r.y - LABEL_ABOVE / 2, points);
        }
        bannerName = roster.get(m.id)?.name ?? "";
        showBanner(banner, m.id);
      } else if (m.kind === GOLDEN) {
        // A golden bug is down: a gold burst on its killer and the banner naming them, for everyone.
        const r = roster.get(m.id);
        if (r) spawnBurst(particles, r.x, r.y, BURST_COUNT, GLOW_GOLD, fxRng);
        goldName = r?.name ?? "";
        showBanner(goldBanner, m.id);
        // Pages the canvas HUD does not reach (the life-over screen, the start screen) show it as a line.
        mode.on.golden(goldenBannerText(goldName));
      }
    }
  };

  let conn: Connection;
  let watching: WatchConnection | null = null;
  if (mode.watch) {
    const on = mode.on;
    conn = watching = watchArena({
      message: onMessage,
      dropped: () => setLive(false),
      unavailable: () => {
        setLive(false);
        on.unavailable();
      },
    });
  } else {
    const { player, on, adopt } = mode;
    const hello = { name: player.name, team: player.team ?? "", player: player.id, touch: () => controls.touched || coarsePointer() };
    const handlers: PlayHandlers = {
      message: (m) => {
        // The server's team (#131): a rejoin's hello says it from now on.
        if (m.t === WELCOME && m.you !== 0 && isTeam(m.team)) {
          hello.team = m.team;
          on.team(m.team);
        }
        onMessage(m);
      },
      status: on.status,
      refused: on.refused,
      // A redeploy with a new build: load it and go straight back in (the life before was ended by
      // the server; see lives.ts countsAsLife).
      newBuild: () => {
        markUpdateReload();
        location.reload();
      },
    };
    let adopted: Connection | null = null;
    if (adopt) {
      try {
        adopted = adopt.play(hello, handlers);
      } catch {
        // Closed since the handoff (refused, or given up): a fresh socket instead.
        adopt.close();
      }
    }
    conn = adopted ?? connectArena(hello, handlers);
  }

  // Layout: the canvas at device resolution, the camera's view, the safe-area insets.
  const probe = document.createElement("div");
  probe.className = "safe-probe";
  document.body.appendChild(probe);
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  const resize = () => {
    // Watching, the view is blurred behind the start screen: 1x is plenty, and cheaper.
    const dpr = watch ? Math.min(1, window.devicePixelRatio || 1) : window.devicePixelRatio || 1;
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
    grenadeButtonAt(controls.dashButton, controls.grenadeButton);
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
    if (alive && GRENADE_KEYS.has(e.code) && !e.repeat) pressGrenade(controls);
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
   * predict nothing (the server holds you still; the revive resets the prediction). `grenade` (#130)
   * goes out only while up.
   */
  const sendInput = (mx: number, my: number, aim: number, fire: boolean, dash: boolean, grenade = false) => {
    const up = alive && !down;
    const input: Input = up
      ? clampInput({ seq: ++seq, mx, my, aim, fire, dash, grenade })
      : clampInput({ seq: ++seq, mx: 0, my: 0, aim, fire: false, dash: alive ? false : dash, grenade: false });
    conn.send(encodeInput(input));
    noteSent(net, input.seq, performance.now());
    if (up) predictLocal(predictor, input);
  };
  // A hidden tab gets no frames: stop rather than repeat the last move until the server's stale limit.
  // Either way the server is told (#117): a hidden tab does not count as a person.
  const onVisibility = () => {
    conn.send(encodeVisibility(document.hidden));
    if (document.hidden && spawned) {
      releaseAll(controls);
      sendInput(0, 0, controls.aim, false, false);
    }
  };

  window.addEventListener("resize", resize);
  // Watching takes no input: the keydown handler would eat WASD and Space typed into the name field.
  if (!watch) {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("visibilitychange", onVisibility);
  }

  const read = { mx: 0, my: 0, aim: 0, fire: false, dash: false, grenade: false, respawn: false };
  const self = { x: 0, y: 0 };
  const at = { x: 0, y: 0, aim: 0, alive: false, inv: false, dash: false, prot: false, fx: 0 };
  const span: BugSpan = { from: null, to: null, t: 0 };
  const bugs: BugsView = {
    x: new Float32Array(BUG_SLOTS),
    y: new Float32Array(BUG_SLOTS),
    heading: new Float32Array(BUG_SLOTS),
    anim: new Float32Array(BUG_SLOTS),
    kind: new Uint8Array(BUG_SLOTS),
    phase: new Uint8Array(BUG_SLOTS),
    angle: new Float32Array(BUG_SLOTS),
    phaseS: new Float32Array(BUG_SLOTS),
    count: 0,
  };
  const floor: FloorView = {
    x: new Float32Array(MAX_PICKUPS_PER_ARENA),
    y: new Float32Array(MAX_PICKUPS_PER_ARENA),
    kind: new Uint8Array(MAX_PICKUPS_PER_ARENA),
    left: new Float32Array(MAX_PICKUPS_PER_ARENA),
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
    floor,
    shots,
    mineAt: 0,
    othersAt: 0,
    you: null,
    particles,
    rings,
    texts,
    tings,
    shake,
    me: null,
    far: [],
    wave: 0,
    hud: hudFx,
    players: 0,
    out: false,
    watch,
    sticks: watch ? [] : [controls.move, controls.aimStick],
    stats: null,
    dashButton: null,
    dashReady: 1,
    grenadeButton: null,
    grenadeReady: 1,
    grenades,
    queen: noQueen,
    golden: noGolden,
    banner,
    bannerName: "",
    goldBanner,
    goldName: "",
  };
  const meter = createFpsMeter();
  const record: WatchRecord | null = watch && import.meta.env.DEV ? { work: new Float64Array(COST_FRAMES), count: 0 } : null;
  if (record) window.bugSwarmWatch = record;
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

  const fillBugs = (rt: number, dt: number) => {
    bugSpan(interp, rt, span);
    bugs.count = 0;
    floor.count = 0;
    const from = span.from;
    if (!from) return;
    // The floor's pickups (#73), from the same snapshot as the bugs, so a drop shows as its bug dies.
    for (const row of from.f) {
      if (floor.count >= MAX_PICKUPS_PER_ARENA) break;
      const i = floor.count++;
      floor.x[i] = row[2];
      floor.y[i] = row[3];
      floor.kind[i] = row[1];
      floor.left[i] = (row[4] - Math.max(0, rt - from.tick)) * DT;
    }
    for (const row of from.b) {
      if (bugs.count >= BUG_SLOTS) break;
      const id = row[0];
      const next = span.to?.bi.get(id);
      let x = row[2];
      let y = row[3];
      const had = headings.get(id);
      let heading = had ?? 0;
      if (next) {
        const dx = next[2] - row[2];
        const dy = next[3] - row[3];
        x += dx * span.t;
        y += dy * span.t;
        if (dx * dx + dy * dy > 0.01) {
          // Eased, not snapped: whole-unit positions (v11) make one tick's direction a few degrees off.
          heading = easeHeading(had, Math.atan2(dy, dx), dt);
          headings.set(id, heading);
        }
      }
      // v6: a bug out of its kind's first phase carries its phase, locked angle and ticks in it.
      const phase = row.length > 4 ? row[4]! : 0;
      let angle = row.length > 4 ? row[5]! : 0;
      let phaseS = 0;
      if (phase !== 0) {
        const nextPhase = next && next.length > 4 ? next[4]! : 0;
        // A bug that turns within a phase (a beetle, #80) turns smoothly between snapshots, the
        // short way round; a locked angle (a dasher's tell) is the same at both ends.
        if (nextPhase === phase) angle += wrapAngle(next![5]! - angle) * span.t;
        // It faces the angle its phase locked (standing in a tell, it has no movement to face).
        heading = angle;
        headings.set(id, heading);
        phaseS = (row[6]! + (nextPhase === phase ? span.t : 0)) * DT;
      }
      const i = bugs.count++;
      bugs.x[i] = x;
      bugs.y[i] = y;
      bugs.heading[i] = heading;
      bugs.anim[i] = (id * 0.618) % 1;
      bugs.kind[i] = row[1];
      bugs.phase[i] = phase;
      bugs.angle[i] = angle;
      bugs.phaseS[i] = phaseS;
    }
    // Forget the headings of bugs long gone.
    if (headings.size > BUG_SLOTS * 2) headings.clear();
  };

  const frame = (now: number) => {
    if (stopped) return;
    const t0 = record ? performance.now() : 0;
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
        sendInput(read.mx, read.my, read.aim, read.fire, alive ? read.dash : read.respawn, read.grenade);
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
    updateRings(rings, dt);
    updateTexts(texts, dt);
    updateTings(tings, dt);
    stepGrenadeFx(grenades, you, mineAt, rt, grenadeBlast);
    updateShake(shake, dt, fxRng);
    updateHudFx(hudFx, dt);
    updateBanner(banner, dt);
    updateBanner(goldBanner, dt);

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
        r.fx = row[10] ?? 0;
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
        r.fx = at.fx;
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
    fillBugs(rt, dt);
    if (watch && drawn.length > 0) {
      if (snapNext) {
        // A new arena on screen: start on its first focus rather than panning in from afar.
        drift.hold = 0;
        stepDrift(drift, cam, drawn, drawn.length, bugs, 0);
        snapCamera(cam, drift.x, drift.y);
        snapNext = false;
      } else stepDrift(drift, cam, drawn, drawn.length, bugs, dt);
    }

    if (showStats && statsReading === -1) {
      statsReading = 0;
      const kbps = readKbps(net, conn.received, now);
      const ack = ackP95(net, now);
      statsText = `${Math.round(meter.fps)} fps · ${drawn.length} players · ${bugs.count} bugs · ${shots.live} shots · ${particles.live} fx · ${kbps === null ? "-" : kbps.toFixed(1)} KB/s · ack ${ack === null ? "-" : Math.round(ack)} ms`;
    }
    scene.count = drawn.length;
    scene.self = selfIndex;
    scene.t = now / 1000;
    scene.mineAt = mineAt;
    scene.othersAt = rt;
    scene.you = you;
    scene.me = haveMe ? me : null;
    scene.wave = wave;
    scene.far = far;
    scene.players = people;
    scene.out = spawned && !alive;
    scene.stats = showStats ? statsText : null;
    scene.dashButton = controls.dashButtonOn && alive && selfIndex >= 0 ? controls.dashButton : null;
    scene.dashReady = 1 - predictor.dashCooldown / DASH_COOLDOWN_TICKS;
    scene.grenadeButton = scene.dashButton ? controls.grenadeButton : null;
    // From your numbers only (#130): the throw is not predicted, so the sweep starts with the server's.
    scene.grenadeReady = haveMe ? 1 - me.gc / GRENADE_COOLDOWN_TICKS : 1;
    scene.queen = queenQ;
    scene.golden = goldenG;
    scene.bannerName = bannerName;
    scene.goldName = goldName;
    renderer.draw(cam, scene);
    if (record) {
      record.work[record.count % COST_FRAMES] = performance.now() - t0;
      record.count++;
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  /** Undoes everything but the connection. */
  const halt = () => {
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
  };

  return {
    respawn() {
      if (stopped || !canRespawn()) return false;
      pressRespawn(controls);
      return true;
    },
    handoff(): WatchConnection | null {
      if (stopped || !watching) return null;
      halt();
      if (watching.open) return watching;
      watching.close();
      return null;
    },
    stop() {
      if (stopped) return;
      halt();
      conn.close();
    },
  };
}
