import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject } from "react";
import { ERROR_NAME, type ErrorCode } from "../shared/arena/protocol";
import { NAME_MAX, TEAMS, type Team } from "../server/rules";
import { startBackdrop } from "./backdrop";
import { fetchBest, fetchPlaying, fetchTeams, fetchTop, type Me, type TopRow } from "./api";
import { startArena, startWatch, type ArenaHandle, type ArenaPlayer, type LifeSummary, type WatchHandle } from "./arena/game";
import type { WatchConnection } from "./arena/net";
import { restartIn } from "./game/guard";
import { HINT_MS, hintText, takeFirstLife } from "./hint";
import { fmt, topLine } from "./over";
import { loadPlayer, setPlayerName, setPlayerTeam, takeRefusedName, takeUpdateReload, type Player } from "./player";
import {
  changeName,
  nameMessage,
  openingNotice,
  playingLine,
  pressEnter,
  pressTeam,
  showMessage,
  startView,
  teamLocked,
  typed,
  type Press,
  type StartView,
} from "./start";
import { TEAM_LOOK } from "./teams";

// The thin shell around the arena's canvas (architecture.md, "Stack"): the start screen on opening
// the page, then the arena (arena/game.ts) with the status pill, the first-life hint and the
// life-over screen over it. No menus between lives: "Play again" (a tap or click anywhere on the
// life-over screen, Enter or Space) respawns in the same arena, from RESTART_DELAY_MS (800 ms,
// game/guard.ts) after the life ended. A reload forced by a redeploy (a new build) skips the start
// screen and rejoins with the stored name and team. A name the server refuses (hidden by `bun run hide`, at
// join or mid-life) brings the start screen back with "Pick a different name".
// The start screen (#79) plays the live arena behind it: a watching connection (arena/game.ts
// startWatch) fades in over the drawn backdrop once it shows an arena, and Play hands that
// connection to the arena, so the player joins on the same socket.

type Phase = "setup" | "arena";

/** Read once per page load (not in a state initializer, which StrictMode runs twice). */
const updateReload = takeUpdateReload();

/** The life-over screen's first read: the server saves the life on the next turn of its event loop. */
const FIRST_READ_MS = 300;
// Then every 4 s: with the server's 1 s cache, a hidden name leaves this screen within 5 s.
const TOP_POLL_MS = 4000;
/** The start screen's "N playing now" is read this often. */
const PLAYING_POLL_MS = 5000;
/** The live arena's fade in, ms (index.html .start-live): the drawn backdrop stops once it is over. */
const LIVE_FADE_MS = 400;

export function App() {
  const [player, setPlayer] = useState<Player>(() => loadPlayer());
  const [notice, setNotice] = useState<string | null>(() => openingNotice(takeRefusedName() !== null, loadPlayer().name));
  // After an update reload a player with a name and team is back in the arena with no tap.
  const [phase, setPhase] = useState<Phase>(updateReload ? "arena" : "setup");
  // The start screen's live arena, and its connection once handed to the arena by Play.
  const watching = useRef<WatchHandle | null>(null);
  const adopt = useRef<WatchConnection | null>(null);

  if (phase === "arena" && player.name !== null && player.team !== null) {
    return (
      <Arena
        id={player.id}
        name={player.name}
        team={player.team}
        adopt={adopt}
        onRefused={(code) => {
          // A hidden name: forget it, so the start screen asks for another one. Anything else final
          // (a team the server doesn't know) goes back to the start screen as it is.
          if (code === ERROR_NAME) {
            setPlayer(setPlayerName(null));
            setNotice(nameMessage("blocked"));
          } else setNotice(null);
          setPhase("setup");
        }}
      />
    );
  }
  return (
    <StartScreen
      player={player}
      notice={notice}
      watching={watching}
      onDone={(name, team) => {
        // The watching socket becomes the player's (before the start screen unmounts and stops it).
        adopt.current = watching.current?.handoff() ?? null;
        setNotice(null);
        setPlayerName(name);
        setPlayer(setPlayerTeam(team));
        setPhase("arena");
      }}
    />
  );
}

/**
 * The start screen: the backdrop, the title and either one "Play as <name>" button (a returning
 * player) or the name field and a button per team. start.ts decides what each press does.
 */
function StartScreen(props: {
  player: Player;
  notice: string | null;
  watching: MutableRefObject<WatchHandle | null>;
  onDone: (name: string, team: Team) => void;
}) {
  const { onDone } = props;
  const [view, setView] = useState<StartView>(() => startView(props.player, props.notice));
  const [value, setValue] = useState(view.name);
  const teamButtons = useRef<Partial<Record<Team, HTMLButtonElement | null>>>({});

  const act = (press: Press) => {
    if (press.kind === "start") onDone(press.name, press.team);
    else if (press.kind === "message") setView((v) => showMessage(v, press.text));
    else teamButtons.current[press.team]?.focus();
  };

  // On "Play as", Enter plays even when nothing has focus (the button handles it when it has).
  const returning = view.kind === "returning" ? view : null;
  const latest = useRef(act);
  latest.current = act;
  useEffect(() => {
    if (!returning) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.repeat && (document.activeElement === document.body || document.activeElement === null)) {
        latest.current({ kind: "start", name: returning.name, team: returning.team });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [returning?.name, returning?.team]);

  // "N playing now": people only, as the board counts them. Hidden at none or when the read fails.
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => {
    let on = true;
    const read = () => void fetchPlaying().then((n) => on && setPlaying(n === "failed" ? null : n));
    read();
    const poll = setInterval(read, PLAYING_POLL_MS);
    return () => {
      on = false;
      clearInterval(poll);
    };
  }, []);

  return (
    <main className="setup">
      <StartBackdrop watching={props.watching} />
      <h1 className="start-title">BUG SWARM</h1>
      <p className="start-tag">Aim. Dodge. Save your team.</p>
      {/* Its space is kept when empty, so nothing moves when the count arrives. */}
      <p className="start-playing">{playingLine(playing)}</p>
      {view.kind === "returning" ? (
        <div className="start-actions">
          <button
            type="button"
            className="start-play"
            autoFocus
            style={{ background: TEAM_LOOK[view.team].color }}
            onKeyDown={holdEnter}
            onClick={() => act(pressEnter(view, value))}
          >
            Play as {view.name}
          </button>
          <button type="button" className="start-change" onClick={() => setView(changeName(view))}>
            change name
          </button>
        </div>
      ) : (
        <div className="start-actions">
          <input
            aria-label="Your name"
            placeholder="Your name"
            autoFocus
            autoComplete="nickname"
            maxLength={NAME_MAX}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setView(typed);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              if (!e.repeat) act(pressEnter(view, value));
            }}
          />
          {view.message && (
            <p role="alert" className="start-alert">
              {view.message}
            </p>
          )}
          <div className="start-teams" role="group" aria-label="Your team">
            {TEAMS.map((t) => (
              <button
                key={t}
                ref={(el) => (teamButtons.current[t] = el)}
                type="button"
                disabled={teamLocked(view, t)}
                style={{ background: TEAM_LOOK[t].color }}
                onKeyDown={holdEnter}
                onClick={() => act(pressTeam(view, value, t))}
              >
                Join {TEAM_LOOK[t].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}

/** A held Enter that moved focus onto a button (Enter in the name field) doesn't press it as it repeats. */
function holdEnter(e: ReactKeyboardEvent) {
  if (e.key === "Enter" && e.repeat) e.preventDefault();
}

/** True when the player asked for reduced motion: the drawn backdrop's still frame, no live arena. */
function reducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Behind the start screen, taking no input: the drawn backdrop (backdrop/), and over it the live
 * arena (#79), dimmed and blurred, which fades in once it shows an arena. Once it is fully in, the
 * drawn backdrop's loop stops (its last frame stays under it); when the live arena drops or the
 * server will not take a watcher, the drawn backdrop runs again. The start screen never waits on
 * it. A hidden tab closes the watch (it holds no watcher slot) and a visible one reopens it.
 */
function StartBackdrop({ watching }: { watching: MutableRefObject<WatchHandle | null> }) {
  const drawn = useRef<HTMLCanvasElement>(null);
  const liveCanvas = useRef<HTMLCanvasElement>(null);
  const backdrop = useRef<ReturnType<typeof startBackdrop> | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    try {
      const b = startBackdrop(drawn.current!);
      backdrop.current = b;
      return () => {
        b.stop();
        backdrop.current = null;
      };
    } catch (err) {
      // Decoration: without it the start screen still works on its plain background.
      console.error("start screen backdrop failed", err);
    }
  }, []);

  useEffect(() => {
    if (reducedMotion()) return;
    let handle: WatchHandle | null = null;
    const begin = () => {
      if (handle || document.hidden) return;
      try {
        handle = startWatch(liveCanvas.current!, { live: setLive, unavailable: () => setLive(false) });
        watching.current = handle;
      } catch (err) {
        console.error("start screen live arena failed", err);
      }
    };
    const end = () => {
      // After Play's handoff this stops the view only: the connection is the arena's now.
      handle?.stop();
      if (watching.current === handle) watching.current = null;
      handle = null;
      setLive(false);
    };
    const onVisibility = () => (document.hidden ? end() : begin());
    begin();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      end();
    };
  }, [watching]);

  useEffect(() => {
    if (!live) return backdrop.current?.hold(false);
    const t = setTimeout(() => backdrop.current?.hold(true), LIVE_FADE_MS);
    return () => clearTimeout(t);
  }, [live]);

  return (
    <>
      <canvas ref={drawn} className="start-backdrop" aria-hidden="true" tabIndex={-1} />
      <canvas ref={liveCanvas} className={live ? "start-live on" : "start-live"} aria-hidden="true" tabIndex={-1} />
    </>
  );
}

/** A touch screen's main pointer: the hint talks about thumbs there. */
function coarsePointer(): boolean {
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** One ended life on screen: what the server said, when it ended (performance.now ms), and which life it was. */
type Ended = { life: LifeSummary; at: number; n: number };

/**
 * The arena: its canvas, the "Connecting..." / "Reconnecting..." pill, the first-life hint and the
 * life-over screen. startArena runs once per mount; its stop() closes the socket and every
 * listener, so StrictMode's second effect run (and a refusal that unmounts it) leaves no socket
 * behind. A socket closed before it opens never says hello, so it never joins or saves a life.
 */
function Arena(props: ArenaPlayer & { adopt: MutableRefObject<WatchConnection | null>; onRefused: (code: ErrorCode) => void }) {
  const { id, name, team, adopt } = props;
  const canvas = useRef<HTMLCanvasElement>(null);
  const handle = useRef<ArenaHandle | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [status, setStatus] = useState<string | null>("Connecting...");
  const [ended, setEnded] = useState<Ended | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // The hint is taken (hint.ts) once per mounted arena, when it first puts you in a life: a refused
  // join never uses it up. A ref, so StrictMode's second effect run can't take it twice.
  const hintTaken = useRef(false);

  useEffect(() => {
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    let lives = 0;
    // The start screen's connection, taken once: StrictMode's second run (after the first closed
    // it) connects afresh.
    const adopted = adopt.current;
    adopt.current = null;
    const running = startArena(canvas.current!, { id, name, team }, {
      status: setStatus,
      refused: (code) => latest.current.onRefused(code),
      over: (life, at) => setEnded({ life, at, n: ++lives }),
      alive: () => setEnded(null),
      firstSpawn: () => {
        if (hintTaken.current) return;
        hintTaken.current = true;
        if (!takeFirstLife()) return;
        setHint(hintText(coarsePointer()));
        hintTimer = setTimeout(() => setHint(null), HINT_MS);
      },
    }, adopted);
    handle.current = running;
    return () => {
      clearTimeout(hintTimer);
      running.stop();
      handle.current = null;
    };
  }, [id, name, team, adopt]);

  return (
    <>
      <canvas ref={canvas} className="arena" />
      {status !== null && (
        <p className="status" role="status">
          {status}
        </p>
      )}
      {/* Layout in index.html (.hint): pointer-events none, so the sticks under it still work. */}
      {hint && !ended && (
        <p className="hint" role="status">
          {hint}
        </p>
      )}
      {ended && <LifeOver key={ended.n} ended={ended} playerId={id} team={team} onAgain={() => handle.current?.respawn()} />}
    </>
  );
}

/**
 * The life-over screen, over the dimmed arena that keeps playing: the life's score, kills, the
 * best, where that stands on the top 10, the Tabs vs Spaces totals, the top 10 itself and a big
 * "Play again". Everything but the life's own numbers is what the server returned (best, rank,
 * rows and totals), polled while it shows. A tap or click anywhere on it, Enter or Space play
 * again once RESTART_DELAY_MS has passed; until then "Play again" is hidden (its space kept).
 */
function LifeOver({ ended, playerId, team, onAgain }: { ended: Ended; playerId: string; team: Team; onAgain: () => void }) {
  const [best, setBest] = useState<number | null | "loading" | "failed">("loading");
  const [top, setTop] = useState<{ top: TopRow[]; me: Me | null } | "loading" | "failed">("loading");
  const [teams, setTeams] = useState<Record<Team, number> | "loading" | "failed">("loading");
  const [ready, setReady] = useState(false);
  const at = ended.at;

  // The reads: the first just after the life is saved, then a poll. A failed poll keeps what is shown.
  useEffect(() => {
    let first = true;
    const read = () => {
      const keep = !first;
      first = false;
      void fetchBest(playerId).then((b) => (b !== "failed" || !keep) && setBest(b));
      void fetchTop(playerId).then((t) => (t !== "failed" || !keep) && setTop(t));
      void fetchTeams().then((t) => (t !== "failed" || !keep) && setTeams(t));
    };
    const firstRead = setTimeout(read, FIRST_READ_MS);
    const poll = setInterval(read, TOP_POLL_MS);
    return () => {
      clearTimeout(firstRead);
      clearInterval(poll);
    };
  }, [playerId]);

  const again = useRef(onAgain);
  again.current = onAgain;
  /** A tap or click anywhere on the screen: set with the guard below. */
  const tapAgain = useRef<() => void>(() => {});
  useEffect(() => {
    const tryAgain = () => {
      if (restartIn(at, performance.now()) === 0) again.current();
    };
    const timer = setTimeout(() => setReady(true), restartIn(at, performance.now()));
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Enter" && e.code !== "NumpadEnter" && e.code !== "Space") return;
      e.preventDefault(); // Space would scroll, Enter would also click a focused button
      if (!e.repeat) tryAgain();
    };
    window.addEventListener("keydown", onKey);
    tapAgain.current = tryAgain;
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  // The rank, the highlighted row and the rows all come from one read, so they always agree.
  const me = typeof top === "object" ? top.me : null;
  const rank = typeof top === "object" && typeof best === "number" ? topLine(me, top.top, best) : null;
  const kills = ended.life.kills;

  // Layout in index.html (.over): portrait stacks the summary, Play again, then the top 10; a short
  // landscape screen puts the summary and Play again left, the top 10 right, with nothing to scroll.
  return (
    <section className="over" aria-label="Life over" onClick={() => tapAgain.current()}>
      <div className="over-summary">
        <h1>Life over</h1>
        <p className="over-score">{fmt(ended.life.score)}</p>
        <p className="over-line">
          {fmt(kills)} {kills === 1 ? "kill" : "kills"}
          {best !== "failed" && <> · Best {best === "loading" ? "..." : best === null ? "-" : fmt(best)}</>}
        </p>
        {rank && <p className="over-rank">{rank}</p>}
        {teams !== "failed" && <Race teams={teams} mine={team} />}
        {/* Hidden, not absent, until playing again is possible, so the layout doesn't move. */}
        <button type="button" className="over-again" style={{ visibility: ready ? "visible" : "hidden" }}>
          Play again
        </button>
      </div>
      <section className="over-board">
        <h2>Top 10</h2>
        {top === "loading" ? (
          <p>Loading...</p>
        ) : top === "failed" ? (
          <p className="over-alert">Couldn't load the top 10</p>
        ) : top.top.length === 0 ? (
          <p>No scores yet</p>
        ) : (
          <ol>
            {top.top.map((row, i) => (
              <li key={i} className={i === me?.row ? "mine" : undefined} aria-current={i === me?.row ? "true" : undefined}>
                <span>{row.name}</span>
                <b>{fmt(row.score)}</b>
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}

/**
 * Tabs vs Spaces: each team's total, and a bar split by them (half and half before either
 * scores). While loading it keeps its size, so the screen doesn't jump. The player's team is bold.
 */
function Race({ teams, mine }: { teams: Record<Team, number> | "loading"; mine: Team | null }) {
  const sum = teams === "loading" ? 0 : TEAMS.reduce((a, t) => a + teams[t], 0);
  return (
    <div className="over-race" aria-label="Tabs vs Spaces">
      <p>
        {TEAMS.map((t) => (
          <span key={t} style={{ color: TEAM_LOOK[t].color, fontWeight: t === mine ? 800 : 400 }}>
            {TEAM_LOOK[t].label} {teams === "loading" ? "..." : teams[t].toLocaleString("en-US")}
          </span>
        ))}
      </p>
      <div className="over-race-bar">
        {TEAMS.map((t) => (
          <span
            key={t}
            style={{ flexGrow: sum === 0 ? 1 : teams === "loading" ? 1 : teams[t], background: TEAM_LOOK[t].color, opacity: teams === "loading" ? 0.3 : 1 }}
          />
        ))}
      </div>
    </div>
  );
}
