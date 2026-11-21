import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ERROR_NAME, type ErrorCode } from "../shared/arena/protocol";
import { NAME_MAX, TEAMS, type Team } from "../server/rules";
import { startBackdrop } from "./backdrop";
import { fetchBest, fetchTeams, fetchTop, type Me, type TopRow } from "./api";
import { startArena, type ArenaHandle, type ArenaPlayer, type LifeSummary } from "./arena/game";
import { restartIn } from "./game/guard";
import { HINT_MS, hintText, takeFirstLife } from "./hint";
import { fmt, topLine } from "./over";
import { loadPlayer, setPlayerName, setPlayerTeam, takeRefusedName, type Player } from "./player";
import { changeName, nameMessage, openingNotice, pressEnter, pressTeam, showMessage, startView, teamLocked, typed, type Press, type StartView } from "./start";
import { TEAM_LOOK } from "./teams";

// The thin shell around the arena's canvas (architecture.md, "Stack"): the start screen on opening
// the page, then the arena (arena/game.ts) with the status pill, the first-life hint and the
// life-over screen over it. No menus between lives: "Play again" (a tap or click anywhere on the
// life-over screen, Enter or Space) respawns in the same arena, from RESTART_DELAY_MS (800 ms,
// game/guard.ts) after the life ended. A name the server refuses (hidden by `bun run hide`, at
// join or mid-life) brings the start screen back with "Pick a different name".

type Phase = "setup" | "arena";

/** The life-over screen's first read: the server saves the life on the next turn of its event loop. */
const FIRST_READ_MS = 300;
// Then every 4 s: with the server's 1 s cache, a hidden name leaves this screen within 5 s.
const TOP_POLL_MS = 4000;

export function App() {
  const [player, setPlayer] = useState<Player>(() => loadPlayer());
  const [notice, setNotice] = useState<string | null>(() => openingNotice(takeRefusedName() !== null, loadPlayer().name));
  const [phase, setPhase] = useState<Phase>("setup");

  if (phase === "arena" && player.name !== null && player.team !== null) {
    return (
      <Arena
        id={player.id}
        name={player.name}
        team={player.team}
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
      onDone={(name, team) => {
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
function StartScreen(props: { player: Player; notice: string | null; onDone: (name: string, team: Team) => void }) {
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

  return (
    <main className="setup">
      <BackdropCanvas />
      <h1 className="start-title">BUG SWARM</h1>
      <p className="start-tag">Aim. Dodge. Save your team.</p>
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

/** The start screen's animated backdrop (backdrop/), behind everything and taking no input. */
function BackdropCanvas() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    try {
      const backdrop = startBackdrop(canvas.current!);
      return () => backdrop.stop();
    } catch (err) {
      // Decoration: without it the start screen still works on its plain background.
      console.error("start screen backdrop failed", err);
    }
  }, []);
  return <canvas ref={canvas} className="start-backdrop" aria-hidden="true" tabIndex={-1} />;
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
function Arena(props: ArenaPlayer & { onRefused: (code: ErrorCode) => void }) {
  const { id, name, team } = props;
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
    });
    handle.current = running;
    return () => {
      clearTimeout(hintTimer);
      running.stop();
      handle.current = null;
    };
  }, [id, name, team]);

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
