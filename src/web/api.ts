import { TEAMS, type Team } from "../server/rules";
import type { RunResult } from "./game/loop";

// The API client. Nothing here throws to its caller and nothing blocks play: every failure is
// logged (with the run id when there is one) and reported as a value the screen can show.
const TIMEOUT_MS = 5000;

export type TopRow = { name: string; score: number };
export type RunStart = { kind: "ok"; runId: string } | { kind: "name-refused" } | { kind: "rate" } | { kind: "failed" };

async function call(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Starts a run. The team goes only when the player has one (a stress run or a stale tab may not). */
export async function startRun(playerId: string, name: string, team: Team | null): Promise<RunStart> {
  try {
    const res = await call("/api/runs", { method: "POST", body: JSON.stringify(team ? { playerId, name, team } : { playerId, name }) });
    const body = (await res.json().catch(() => null)) as { runId?: unknown; error?: unknown } | null;
    if (res.ok && typeof body?.runId === "string") return { kind: "ok", runId: body.runId };
    if (res.status === 400 && body?.error === "name") return { kind: "name-refused" };
    if (res.status === 429) {
      console.error("run start refused: too many runs (HTTP 429)");
      return { kind: "rate" };
    }
    console.error(`run start failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("run start failed", err);
  }
  return { kind: "failed" };
}

export async function endRun(runId: string, result: RunResult): Promise<"saved" | "failed"> {
  try {
    const res = await call(`/api/runs/${encodeURIComponent(runId)}/end`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    if (res.ok) return "saved";
    console.error(`run ${runId}: saving the score failed: HTTP ${res.status}`);
  } catch (err) {
    console.error(`run ${runId}: saving the score failed`, err);
  }
  return "failed";
}

/**
 * Finishes a run: once its start settles, saves the result under its run id. A run with no
 * start (`null`: a stress run) is 'not-saved' and sends nothing. A start the server refused for
 * too many runs is 'rate-limited' and sends nothing: the next run tries again.
 */
export async function finishRun(
  runStart: Promise<RunStart> | null,
  result: RunResult,
): Promise<"saved" | "failed" | "not-saved" | "rate-limited"> {
  if (!runStart) return "not-saved";
  const s = await runStart;
  if (s.kind === "ok") return endRun(s.runId, result);
  if (s.kind === "rate") {
    console.error("score not saved: the server refused the run start (too many runs)");
    return "rate-limited";
  }
  console.error("score not saved: the run never got a run id");
  return "failed";
}

export async function fetchTop(): Promise<TopRow[] | "failed"> {
  try {
    const res = await call("/api/top");
    const body = (await res.json()) as { top?: unknown };
    if (res.ok && Array.isArray(body.top)) return body.top as TopRow[];
    console.error(`top 10 failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("top 10 failed", err);
  }
  return "failed";
}

/** Each team's total, as the server counts it. */
export async function fetchTeams(): Promise<Record<Team, number> | "failed"> {
  try {
    const res = await call("/api/teams");
    const body = (await res.json()) as { teams?: Record<string, unknown> };
    const teams = body.teams;
    if (res.ok && teams && TEAMS.every((t) => typeof teams[t] === "number")) {
      return Object.fromEntries(TEAMS.map((t) => [t, teams[t]])) as Record<Team, number>;
    }
    console.error(`team totals failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("team totals failed", err);
  }
  return "failed";
}

/** The player's best saved score: a number, or null with none yet. */
export async function fetchBest(playerId: string): Promise<number | null | "failed"> {
  try {
    const res = await call(`/api/players/${encodeURIComponent(playerId)}/best`);
    const body = (await res.json()) as { best?: unknown };
    if (res.ok && (typeof body.best === "number" || body.best === null)) return body.best;
    console.error(`best score failed: HTTP ${res.status}`);
  } catch (err) {
    console.error("best score failed", err);
  }
  return "failed";
}
