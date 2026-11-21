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

export function setPlayerName(name: string | null): Player {
  return save({ ...loadPlayer(), name });
}

export function setPlayerTeam(team: Team): Player {
  return save({ ...loadPlayer(), team });
}

const UPDATED_KEY = "bugswarm.updated";

/**
 * Marks the reload a redeploy forces (a new build), just before it: the reloaded page goes
 * straight back into the arena instead of the start screen. Kept in sessionStorage (this tab
 * only); where that is unavailable the reload opens on the start screen.
 */
export function markUpdateReload(): void {
  try {
    sessionStorage.setItem(UPDATED_KEY, "1");
  } catch {
    // No storage: the start screen it is.
  }
}

/** Whether this page load is an update reload, once: a later manual reload opens on the start screen. */
export function takeUpdateReload(): boolean {
  try {
    const updated = sessionStorage.getItem(UPDATED_KEY) === "1";
    sessionStorage.removeItem(UPDATED_KEY);
    return updated;
  } catch {
    return false;
  }
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
