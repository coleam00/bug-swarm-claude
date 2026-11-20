import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { NAME_MAX, checkName } from "../server/rules";
import { endRun, fetchBest, fetchTop, startRun, type RunStart, type TopRow } from "./api";
import { startGame, type RunResult } from "./game/loop";
import { loadPlayer, setPlayerName, type Player } from "./player";

// The thin shell around the canvas: name entry, the run, and the game-over screen.
// No menus between runs: game over -> any key or a fresh tap -> the next run.

type Over = {
  result: RunResult;
  saved: "saving" | "saved" | "failed";
  best: number | null | "loading" | "failed";
  top: TopRow[] | "loading" | "failed";
};

type Phase = { kind: "name" } | { kind: "playing"; run: number } | { kind: "over"; run: number; over: Over };

/** Game over ignores input this long, so the finger still steering doesn't restart at once. */
const RESTART_DELAY_MS = 750;
const TOP_POLL_MS = 5000;

export function App() {
  const [player, setPlayer] = useState<Player>(() => loadPlayer());
  const [phase, setPhase] = useState<Phase>(() => (loadPlayer().name ? { kind: "playing", run: 1 } : { kind: "name" }));
  const runs = useRef(1);

  const play = () => {
    runs.current += 1;
    setPhase(loadPlayer().name ? { kind: "playing", run: runs.current } : { kind: "name" });
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

  useEffect(() => {
    const { player } = latest.current;
    if (!start.current) {
      start.current = startRun(player.id, player.name ?? "").then((s) => {
        if (s.kind === "name-refused") latest.current.onNameRefused();
        return s;
      });
    }
    const runStart = start.current;
    const stop = startGame(canvas.current!, {
      onOver: (result) => {
        const report = (over: Over) => latest.current.onOver(over);
        report({ result, saved: "saving", best: "loading", top: "loading" });
        void (async () => {
          const s = await runStart;
          const saved = s.kind === "ok" ? await endRun(s.runId, result) : "failed";
          if (s.kind !== "ok") console.error("score not saved: the run never got a run id");
          const [best, top] = await Promise.all([fetchBest(player.id), fetchTop()]);
          report({ result, saved, best, top });
        })();
      },
    });
    return stop;
  }, []);

  return <canvas ref={canvas} style={{ position: "fixed", inset: 0, width: "100%", height: "100%", touchAction: "none", display: "block" }} />;
}

function OverScreen({ over, onRestart }: { over: Over; onRestart: () => void }) {
  const [top, setTop] = useState(over.top);
  const [ready, setReady] = useState(false);
  useEffect(() => setTop(over.top), [over.top]);

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

  return (
    <main style={{ ...screen, gap: 12, userSelect: "none" }}>
      <h1 style={{ fontSize: 40, margin: 0 }}>Game over</h1>
      <p style={{ fontSize: 56, fontWeight: 800, margin: 0 }}>{over.result.score}</p>
      {over.best !== "failed" && (
        <p style={{ fontSize: 24, margin: 0 }}>Best: {over.best === "loading" ? "..." : over.best === null ? "-" : over.best}</p>
      )}
      {over.saved === "failed" && (
        <p role="alert" style={{ fontSize: 22, color: "#fda4af", margin: 0 }}>
          Couldn't save your score
        </p>
      )}
      <section style={{ width: "min(100%, 420px)" }}>
        <h2 style={{ fontSize: 26, margin: "8px 0" }}>Top 10</h2>
        {top === "loading" ? (
          <p style={{ fontSize: 20, margin: 0 }}>Loading...</p>
        ) : top === "failed" ? (
          <p style={{ fontSize: 20, margin: 0, color: "#fda4af" }}>Couldn't load the top 10</p>
        ) : top.length === 0 ? (
          <p style={{ fontSize: 20, margin: 0 }}>No scores yet</p>
        ) : (
          <ol style={{ fontSize: 22, margin: 0, paddingLeft: 36, lineHeight: 1.5 }}>
            {top.map((row, i) => (
              <li key={i}>
                <span style={{ display: "inline-flex", justifyContent: "space-between", width: "100%" }}>
                  <span>{row.name}</span>
                  <span style={{ fontWeight: 700 }}>{row.score}</span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p style={{ fontSize: 22, margin: "8px 0 0", opacity: ready ? 1 : 0.3 }}>Tap or press any key to play again</p>
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
