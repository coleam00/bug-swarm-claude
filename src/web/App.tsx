import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { NAME_MAX, TEAMS, type Team, type UpgradeId } from "../server/rules";
import { startBackdrop } from "./backdrop";
import { fetchBest, fetchTeams, fetchTop, finishRun, startRun, type Me, type RunStart, type TopRow } from "./api";
import { UPGRADES } from "./game/config";
import { restartIn } from "./game/guard";
import { HINT_MS, hintText, takeFirstRun } from "./hint";
import { startGame, type Game as Running, type RunResult } from "./game/loop";
import { fmt, rankLines, saveNotice, upgradeLevels, type SaveState } from "./over";
import { loadPlayer, nextScreen, setPlayerName, setPlayerTeam, takeArenaRefusedName, takeRefusedName, type Player } from "./player";
import { changeName, nameMessage, openingNotice, pressEnter, pressTeam, showMessage, startView, teamLocked, typed, type Press, type StartView } from "./start";
import { STRESS } from "./stress";
import { TEAM_LOOK } from "./teams";

/** Shown under the name field when a name the player already had is refused now. */
const NAME_NOW_REFUSED = nameMessage("blocked");

// The thin shell around the canvas: the start screen (name and team, or "Play as" for a returning
// player) on opening the page, the run, and the game-over screen.
// No menus between runs: game over -> any key, a fresh tap or "Play again" -> the next run.
// Game over ignores them for RESTART_DELAY_MS (800 ms, game/guard.ts) after death.
// A stress run (`?stress`, dev and bench builds only) needs no name or team and is never
// submitted: it starts no run on the server, saves nothing and fetches no best.

type Over = {
  result: RunResult;
  saved: SaveState;
  best: number | null | "loading" | "failed";
  /** The top 10 and, unless a stress run, where the player stands, both from the server's one ranking. */
  top: { top: TopRow[]; me: Me | null } | "loading" | "failed";
  teams: Record<Team, number> | "loading" | "failed";
  /** When the run ended (performance.now()): restart input is ignored until RESTART_DELAY_MS after it. */
  diedAt: number;
};

type Phase = { kind: "setup" } | { kind: "playing"; run: number } | { kind: "over"; run: number; over: Over };

// Every 4 s: with the server's 1 s cache, a hidden name leaves this screen within 5 s.
const TOP_POLL_MS = 4000;

export function App() {
  const [player, setPlayer] = useState<Player>(() => loadPlayer());
  const [notice, setNotice] = useState<string | null>(() => {
    const refusedNow = takeRefusedName() !== null;
    return openingNotice(refusedNow, takeArenaRefusedName());
  });
  const runs = useRef(1);
  const phaseFor = (run: number, pageLoad: boolean): Phase =>
    nextScreen(loadPlayer(), STRESS > 0, pageLoad) === "play" ? { kind: "playing", run } : { kind: "setup" };
  const [phase, setPhase] = useState<Phase>(() => phaseFor(1, true));

  const play = () => {
    runs.current += 1;
    setPhase(phaseFor(runs.current, false));
  };

  if (phase.kind === "setup") {
    return (
      <StartScreen
        player={player}
        notice={notice}
        onDone={(name, team) => {
          setNotice(null);
          setPlayerName(name);
          setPlayer(setPlayerTeam(team));
          play();
        }}
      />
    );
  }
  if (phase.kind === "playing") {
    return (
      <Game
        key={phase.run}
        player={player}
        onNameRefused={() => {
          setNotice(NAME_NOW_REFUSED);
          setPlayer(setPlayerName(null));
        }}
        // The save settles after the over screen shows; drop it if the player has moved on.
        onOver={(over) => setPhase((p) => (p.kind !== "setup" && p.run === phase.run ? { kind: "over", run: phase.run, over } : p))}
      />
    );
  }
  return <OverScreen key={phase.run} over={phase.over} playerId={STRESS ? undefined : player.id} team={player.team} onRestart={play} />;
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

function Game(props: { player: Player; onNameRefused: () => void; onOver: (over: Over) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // One run_started per run: the request is made once per mounted run, not per effect run
  // (StrictMode runs effects twice in development; refs survive that).
  const start = useRef<Promise<RunStart> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const game = useRef<Running | null>(null);
  const [cards, setCards] = useState<readonly UpgradeId[] | null>(null);
  // The first-run steering hint (hint.ts). Decided once per mounted run in a ref, like `start`:
  // StrictMode's second effect run must not find it already taken and hide it. Never in a stress
  // run, so `bun run bench` neither draws it nor uses it up.
  const firstRun = useRef<boolean | null>(null);
  const [hintShown, setHintShown] = useState<string | null>(null);

  useEffect(() => {
    const { player } = latest.current;
    if (firstRun.current === null) firstRun.current = !STRESS && takeFirstRun();
    let hintTimer: ReturnType<typeof setTimeout> | undefined;
    if (firstRun.current) {
      setHintShown(hintText(coarsePointer()));
      hintTimer = setTimeout(() => setHintShown(null), HINT_MS);
    }
    if (!start.current && !STRESS) {
      start.current = startRun(player.id, player.name ?? "", player.team).then((s) => {
        if (s.kind === "name-refused") latest.current.onNameRefused();
        return s;
      });
    }
    const runStart = start.current;
    const running = startGame(canvas.current!, {
      stress: STRESS,
      onChoice: setCards,
      onMove: () => setHintShown(null),
      onOver: (result) => {
        // Stamped once: the second report (once saved) keeps the same restart window.
        const diedAt = performance.now();
        const report = (over: Over) => latest.current.onOver(over);
        report({ result, saved: "saving", best: "loading", top: "loading", teams: "loading", diedAt });
        void (async () => {
          const saved = await finishRun(runStart, result);
          const [best, top, teams] = await Promise.all([STRESS ? null : fetchBest(player.id), fetchTop(STRESS ? undefined : player.id), fetchTeams()]);
          report({ result, saved, best, top, teams, diedAt });
        })();
      },
    });
    game.current = running;
    return () => {
      clearTimeout(hintTimer);
      running.stop();
      game.current = null;
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", touchAction: "none", display: "block" }} />
      {/* Layout in index.html (.hint): pointer-events none, so a drag that starts on it steers. */}
      {hintShown && (
        <p className="hint" role="status">
          {hintShown}
        </p>
      )}
      {cards && <ChoiceScreen cards={cards} onPick={(i, pressedAt) => game.current?.pick(i, pressedAt)} />}
    </>
  );
}

/** A touch screen's main pointer: the hint says "drag" there. */
function coarsePointer(): boolean {
  try {
    return matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/**
 * The upgrade choice, over the paused run: a big card per upgrade, tap one or press 1-3. No
 * countdown. The cards fade in over CHOICE_DELAY_MS (350 ms), the time pick() refuses them in.
 * A tap is timed from when the finger lands, not when it lifts (when the click comes).
 */
function ChoiceScreen({ cards, onPick }: { cards: readonly UpgradeId[]; onPick: (index: number, pressedAt: number) => void }) {
  // Layout and sizes live in index.html (.choice). It covers the canvas, so a tap here never steers.
  const pressedAt = useRef<number | null>(null);
  const click = (i: number) => {
    // A click with no press first (Enter or Space on a focused card) is timed now.
    const at = pressedAt.current ?? performance.now();
    pressedAt.current = null;
    onPick(i, at);
  };
  return (
    <section className="choice" aria-label="Pick an upgrade">
      <h2>Pick an upgrade</h2>
      <div className="choice-cards">
        {cards.map((id, i) => (
          <button key={id} type="button" onPointerDown={() => (pressedAt.current = performance.now())} onClick={() => click(i)}>
            <kbd>{i + 1}</kbd>
            <b>{UPGRADES[id].name}</b>
            <span>{UPGRADES[id].line}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function OverScreen({ over, playerId, team, onRestart }: { over: Over; playerId: string | undefined; team: Team | null; onRestart: () => void }) {
  const [top, setTop] = useState(over.top);
  const [teams, setTeams] = useState(over.teams);
  const [ready, setReady] = useState(false);
  useEffect(() => setTop(over.top), [over.top]);
  useEffect(() => setTeams(over.teams), [over.teams]);

  const upgrades = upgradeLevels(over.result.upgrades);
  const notice = saveNotice(over.saved);
  // The rank, the highlighted row and the rows all come from one read, so they always agree.
  const me = typeof top === "object" ? top.me : null;
  const ranks = rankLines(me);

  // The live top 10 and team totals: poll while this screen shows. Both show only what the
  // server returned; this run's score is in the totals once the server has counted it.
  useEffect(() => {
    if (over.saved === "saving") return;
    const id = setInterval(() => {
      void fetchTop(playerId).then((t) => t !== "failed" && setTop(t));
      void fetchTeams().then((t) => t !== "failed" && setTeams(t));
    }, TOP_POLL_MS);
    return () => clearInterval(id);
  }, [over.saved, playerId]);

  // Any key, a fresh tap or "Play again" starts the next run, once RESTART_DELAY_MS has passed
  // since death. The guard decides; the timer only reveals "Play again" and the hint at that moment.
  const restart = useRef(onRestart);
  restart.current = onRestart;
  const diedAt = over.diedAt;
  const tryRestart = useCallback(() => {
    if (restartIn(diedAt, performance.now()) === 0) restart.current();
  }, [diedAt]);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), restartIn(diedAt, performance.now()));
    const onKey = (e: KeyboardEvent) => {
      if (!e.repeat) tryRestart();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", tryRestart);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", tryRestart);
    };
  }, [diedAt, tryRestart]);

  // Layout and sizes live in index.html (.over): on a short landscape screen (a phone held
  // sideways) the summary and Play again sit left, the top 10 and the upgrades right, so all of it
  // fits a 360 px tall screen with nothing to scroll. In portrait, Play again comes before both.
  return (
    <main className="over">
      <div className="over-summary">
        <h1>Game over</h1>
        <p className="over-score">{fmt(over.result.score)}</p>
        {teams !== "failed" && <Race teams={teams} mine={team} />}
        {over.saved === "not-saved" ? (
          <p>Stress test: not saved</p>
        ) : (
          over.best !== "failed" && <p>Best: {over.best === "loading" ? "..." : over.best === null ? "-" : fmt(over.best)}</p>
        )}
        {ranks.length > 0 && (
          <p className="over-rank">
            {ranks.map((line) => (
              <span key={line}>{line}</span>
            ))}
          </p>
        )}
        {notice && (
          <p role="alert" className="over-alert">
            {notice}
          </p>
        )}
        {/* Hidden, not absent, until restarting is possible, so the layout doesn't move. */}
        <div className="over-again" style={{ visibility: ready ? "visible" : "hidden" }}>
          <button type="button" onClick={tryRestart}>
            Play again
          </button>
          <p className="over-hint">Tap or press any key to play again</p>
        </div>
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
        {upgrades.length === 0 ? (
          <p className="over-upgrades">No upgrades</p>
        ) : (
          <ul className="over-upgrades" aria-label="Upgrades">
            {upgrades.map((u) => (
              <li key={u.id}>
                {u.name} <b>L{u.level}</b>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
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
