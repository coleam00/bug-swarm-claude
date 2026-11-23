import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { fetchBest, fetchPlaying, fetchTeams, fetchTop } from "./api";
import { TEAMS } from "../server/rules";

const realFetch = globalThis.fetch;
let respond: () => Response | Promise<Response>;
let url: string | undefined;
beforeEach(() => {
  url = undefined;
  globalThis.fetch = (async (to: string) => {
    url = to;
    return respond();
  }) as unknown as typeof fetch;
  spyOn(console, "error").mockImplementation(() => {}); // failures are logged; keep the output clean
});
afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restore(); // give console.error back to the test files that run after this one
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const down = () => Promise.reject(new TypeError("Failed to fetch"));

test("fetchTeams: both totals, else a failure instead of throwing", async () => {
  respond = () => json(200, { teams: { tabs: 120, spaces: 80 } });
  expect(await fetchTeams()).toEqual({ tabs: 120, spaces: 80 });
  expect(url).toBe("/api/teams");
  respond = () => json(200, { teams: { tabs: 120 } });
  expect(await fetchTeams()).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchTeams()).toBe("failed");
  respond = down;
  expect(await fetchTeams()).toBe("failed");
});

test("fetchTop and fetchBest report a failure instead of throwing", async () => {
  respond = () => json(200, { top: [{ name: "Robo", score: 40 }] });
  expect(await fetchTop()).toEqual({ top: [{ name: "Robo", score: 40 }], me: null });
  expect(url).toBe("/api/top");
  respond = () => json(200, { best: null });
  expect(await fetchBest("player-0001")).toBeNull();
  respond = down;
  expect(await fetchTop()).toBe("failed");
  expect(await fetchBest("player-0001")).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchTop()).toBe("failed");
});

test("fetchTop with a player id asks for their rank; a malformed rank is dropped and the top 10 kept", async () => {
  const top = [{ name: "Robo", score: 40 }];
  const me = { rank: 2, ranked: 9, next: { rank: 1, points: 11 }, row: 1 };
  respond = () => json(200, { top, me });
  expect(await fetchTop("player-0001")).toEqual({ top, me });
  expect(url).toBe("/api/top?player=player-0001");
  const none = { rank: null, ranked: 9, next: null, row: null };
  respond = () => json(200, { top, me: none });
  expect(await fetchTop("player-0001")).toEqual({ top, me: none });
  const held = { ...none, held: { name: "Churn", rank: 1, score: 1900 } };
  respond = () => json(200, { top, me: held });
  expect(await fetchTop("player-0001")).toEqual({ top, me: held });
  for (const bad of [undefined, null, "2", { ...me, rank: "2" }, { ...none, held: { name: "Churn", rank: 1 } }, { ...none, held: null }, { ...me, next: { rank: 1 } }, { ...me, row: -1 }, { ...me, ranked: undefined }]) {
    respond = () => json(200, { top, me: bad });
    expect(await fetchTop("player-0001")).toEqual({ top, me: null });
  }
  respond = down;
  expect(await fetchTop("player-0001")).toBe("failed");
});

test("fetchPlaying: the board's people playing now, else a failure instead of throwing", async () => {
  const board = { top: [], teams: { tabs: 0, spaces: 0 }, playing: 3, arenas: [{ id: 1, players: 1, wave: 2 }, { id: 2, players: 2, wave: 1 }] };
  respond = () => json(200, board);
  expect(await fetchPlaying()).toBe(3);
  expect(url).toBe("/api/board");
  respond = () => json(200, { ...board, playing: "3" });
  expect(await fetchPlaying()).toBe("failed");
  respond = () => new Response("not json", { status: 200 });
  expect(await fetchPlaying()).toBe("failed");
  respond = () => json(500, {});
  expect(await fetchPlaying()).toBe("failed");
  respond = down;
  expect(await fetchPlaying()).toBe("failed");
});
