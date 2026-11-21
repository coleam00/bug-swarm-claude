import { checkName, isTeam, type Team } from "../server/rules";

// Who is playing: a random id this browser makes on its first visit, the name they picked and
// their team. Kept in localStorage; where that is unavailable (private mode, blocked storage) it
// lives in memory for this page only. A player from before teams has a name and no team.
export type Player = { id: string; name: string | null; team: Team | null };

const KEY = "bugswarm.player";
let memory: Player | null = null;
let refused: string | null = null;

/** The stored player, else the one kept in memory, else a new one. A stored invalid name or team is dropped. */
export function loadPlayer(): Player {
  let stored: unknown = null;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    stored = null;
  }
  const s = (stored ?? memory) as Partial<Player> | null;
  const id = typeof s?.id === "string" && /^[0-9a-f]{32}$/.test(s.id) ? s.id : newId();
  const name = typeof s?.name === "string" && checkName(s.name).ok ? s.name : null;
  if (typeof s?.name === "string" && name === null) refused = s.name;
  const team = isTeam(s?.team) ? s.team : null;
  return save({ id, name, team });
}

/**
 * The stored name the last load dropped because the name rules now refuse it, once: name entry
 * says why it is asking again, instead of looking like the game forgot the player.
 */
export function takeRefusedName(): string | null {
  const name = refused;
  refused = null;
  return name;
}

const ARENA_REFUSED_KEY = "bugswarm.arenaRefused";

/**
 * The arena (/arena) refused the stored name and is sending the player to `/`: keep the name
 * (`/` still accepts it) and leave a note, for this tab only, so `/` can say why.
 */
export function noteArenaRefusedName(name: string): void {
  try {
    sessionStorage.setItem(ARENA_REFUSED_KEY, name);
  } catch {
    // Storage is unavailable: then the arena had no stored player to refuse either.
  }
}

/** The name the arena refused, once (the note is cleared), or null. */
export function takeArenaRefusedName(): string | null {
  try {
    const name = sessionStorage.getItem(ARENA_REFUSED_KEY);
    sessionStorage.removeItem(ARENA_REFUSED_KEY);
    return name;
  } catch {
    return null;
  }
}

export function setPlayerName(name: string | null): Player {
  return save({ ...loadPlayer(), name });
}

export function setPlayerTeam(team: Team): Player {
  return save({ ...loadPlayer(), team });
}

/**
 * Where a run begins. Opening the page always shows the start screen (a returning player gets
 * one "Play as" button there). Between runs in the same page it is straight into play once the
 * player has a name and a team, else the start screen. A stress run needs neither.
 */
export function nextScreen(player: Player, stress: boolean, pageLoad: boolean): "setup" | "play" {
  if (stress) return "play";
  if (pageLoad) return "setup";
  return player.name !== null && player.team !== null ? "play" : "setup";
}

/** For tests: forget the player kept in memory, as a fresh page load would. */
export function forgetPlayerForTests(): void {
  memory = null;
  refused = null;
}

function save(player: Player): Player {
  memory = player;
  try {
    localStorage.setItem(KEY, JSON.stringify(player));
  } catch {
    // Storage is unavailable: the player lasts for this page.
  }
  return player;
}

// 16 random bytes in hex. Not crypto.randomUUID: it is missing on plain-HTTP origins.
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
