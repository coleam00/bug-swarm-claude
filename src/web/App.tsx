import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { NAME_MAX, checkName, type UpgradeId } from "../server/rules";
import { fetchBest, fetchTop, finishRun, startRun, type RunStart, type TopRow } from "./api";
import { UPGRADES } from "./game/config";
import { startGame, type Game as Running, type RunResult } from "./game/loop";
import { upgradeLevels } from "./over";
import { loadPlayer, setPlayerName, type Player } from "./player";
import { STRESS } from "./stress";

// The thin shell around the canvas: name entry, the run, and the game-over screen.
// No menus between runs: game over -> any key or a fresh tap -> the next run.
// A stress run (`?stress`, dev and bench builds only) needs no name and is never submitted: it
// starts no run on the server, saves nothing and fetches no best.

type Over = {
  result: RunResult;
  saved: "saving" | "saved" | "failed" | "not-saved";
  best: number | null | "loading" | "failed";
  top: TopRow[] | "loading" | "failed";
};

type Phase = { kind: "name" } | { kind: "playing"; run: number } | { kind: "over"; run: number; over: Over };

/** Game over ignores input this long, so the finger still steering doesn't restart at once. */
const RESTART_DELAY_MS = 750;
// Every 4 s: with the server's 1 s cache, a hidden name leaves this screen within 5 s.
const TOP_POLL_MS = 4000;

export function App() {
  const [player, setPlayer] = useState<Player>(() => loadPlayer());
  const [phase, setPhase] = useState<Phase>(() => (STRESS || loadPlayer().name ? { kind: "playing", run: 1 } : { kind: "name" }));
  const runs = useRef(1);

  const play = () => {
    runs.current += 1;
    setPhase(STRESS || loadPlayer().name ? { kind: "playing", run: runs.current } : { kind: "name" });
  };

  if (phase.kind === "name") {
    return (
      <NameScreen
        onName={(name) => {
          setPlayer(setPlayerName(name));
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
        onNameRefused={() => setPlayer(setPlayerName(null))}
        // The save settles after the over screen shows; drop it if the player has moved on.
        onOver={(over) => setPhase((p) => (p.kind !== "name" && p.run === phase.run ? { kind: "over", run: phase.run, over } : p))}
      />
    );
  }
  return <OverScreen key={phase.run} over={phase.over} onRestart={play} />;
}

function NameScreen({ onName }: { onName: (name: string) => void }) {
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const checked = checkName(value);
    if (checked.ok) return onName(checked.name);
    setMessage(
      checked.reason === "blocked"
        ? "That name isn't allowed. Try another."
        : checked.reason === "length"
          ? `Use 2 to ${NAME_MAX} characters.`
          : "Use letters, numbers, spaces, - and _ only.",
    );
  };
  return (
    <main style={screen}>
      <h1 style={{ fontSize: 44, margin: 0 }}>Bug Swarm</h1>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 16, width: "min(100%, 360px)" }}>
        <label htmlFor="name" style={{ fontSize: 22 }}>
          Your name on the board
        </label>
        <input
          id="name"
          autoFocus
          autoComplete="nickname"
          maxLength={NAME_MAX}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMessage(null);
          }}
          style={{ fontSize: 24, padding: "10px 12px", borderRadius: 8, border: "2px solid #334155", background: "#0f172a", color: "#f8fafc" }}
        />
        {message && (
          <p role="alert" style={{ color: "#fda4af", fontSize: 20, margin: 0 }}>
            {message}
          </p>
        )}
        <button type="submit" style={{ minHeight: 56, fontSize: 24, fontWeight: 700, borderRadius: 8, border: 0, background: "#22d3ee", color: "#05070d" }}>
          Play
        </button>
      </form>
    </main>
  );
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

  useEffect(() => {
    const { player } = latest.current;
    if (!start.current && !STRESS) {
      start.current = startRun(player.id, player.name ?? "").then((s) => {
        if (s.kind === "name-refused") latest.current.onNameRefused();
        return s;
      });
    }
    const runStart = start.current;
    const running = startGame(canvas.current!, {
      stress: STRESS,
      onChoice: setCards,
      onOver: (result) => {
        const report = (over: Over) => latest.current.onOver(over);
        report({ result, saved: "saving", best: "loading", top: "loading" });
        void (async () => {
          const saved = await finishRun(runStart, result);
          const [best, top] = await Promise.all([STRESS ? null : fetchBest(player.id), fetchTop()]);
          report({ result, saved, best, top });
        })();
      },
    });
    game.current = running;
    return () => {
      running.stop();
      game.current = null;
    };
  }, []);

  return (
    <>
      <canvas ref={canvas} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", touchAction: "none", display: "block" }} />
      {cards && <ChoiceScreen cards={cards} onPick={(i) => game.current?.pick(i)} />}
    </>
  );
}

/** The upgrade choice, over the paused run: a big card per upgrade, tap one or press 1-3. No timer. */
function ChoiceScreen({ cards, onPick }: { cards: readonly UpgradeId[]; onPick: (index: number) => void }) {
  // Layout and sizes live in index.html (.choice). It covers the canvas, so a tap here never steers.
  return (
    <section className="choice" aria-label="Pick an upgrade">
      <h2>Pick an upgrade</h2>
      <div className="choice-cards">
        {cards.map((id, i) => (
          <button key={id} type="button" onClick={() => onPick(i)}>
            <kbd>{i + 1}</kbd>
            <b>{UPGRADES[id].name}</b>
            <span>{UPGRADES[id].line}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function OverScreen({ over, onRestart }: { over: Over; onRestart: () => void }) {
  const [top, setTop] = useState(over.top);
  const [ready, setReady] = useState(false);
  useEffect(() => setTop(over.top), [over.top]);

  const upgrades = upgradeLevels(over.result.upgrades);

  // The live top 10: poll while this screen shows.
  useEffect(() => {
    if (over.saved === "saving") return;
    const id = setInterval(() => {
      void fetchTop().then((t) => t !== "failed" && setTop(t));
    }, TOP_POLL_MS);
    return () => clearInterval(id);
  }, [over.saved]);

  // Any key or a fresh tap starts the next run, after a short pause.
  const restart = useRef(onRestart);
  restart.current = onRestart;
  useEffect(() => {
    let armed = false;
    const timer = setTimeout(() => {
      armed = true;
      setReady(true);
    }, RESTART_DELAY_MS);
    const onKey = (e: KeyboardEvent) => {
      if (armed && !e.repeat) restart.current();
    };
    const onPointer = () => {
      if (armed) restart.current();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, []);

  // Layout and sizes live in index.html (.over): on a phone held sideways the score and the
  // top 10 sit side by side, so all of it fits a 390 px tall screen with nothing to scroll.
  return (
    <main className="over">
      <div className="over-summary">
        <h1>Game over</h1>
        <p className="over-score">{over.result.score}</p>
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
        {over.saved === "not-saved" ? (
          <p>Stress test: not saved</p>
        ) : (
          over.best !== "failed" && <p>Best: {over.best === "loading" ? "..." : over.best === null ? "-" : over.best}</p>
        )}
        {over.saved === "failed" && (
          <p role="alert" className="over-alert">
            Couldn't save your score
          </p>
        )}
        <p className="over-hint" style={{ opacity: ready ? 1 : 0.3 }}>
          Tap or press any key to play again
        </p>
      </div>
      <section className="over-board">
        <h2>Top 10</h2>
        {top === "loading" ? (
          <p>Loading...</p>
        ) : top === "failed" ? (
          <p className="over-alert">Couldn't load the top 10</p>
        ) : top.length === 0 ? (
          <p>No scores yet</p>
        ) : (
          <ol>
            {top.map((row, i) => (
              <li key={i}>
                <span>{row.name}</span>
                <b>{row.score}</b>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

const screen: CSSProperties = {
  minHeight: "100dvh",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 24,
  padding: 16,
  color: "#f8fafc",
  fontFamily: "system-ui, sans-serif",
  textAlign: "center",
};
