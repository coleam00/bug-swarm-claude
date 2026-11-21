import { checkName, isTeam, type Team } from "../server/rules";

// Who is playing: a random id this browser makes on its first visit, the name they picked and
// their team. Kept in localStorage; where that is unavailable (private mode, blocked storage) it
// lives in memory for this page only. A player from before teams has a name and no team.
export type Player = { id: string; name: string | null; team: Team | null };

const KEY = "bugswarm.player";
let memory: Player | null = null;

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
  const team = isTeam(s?.team) ? s.team : null;
  return save({ id, name, team });
}

export function setPlayerName(name: string | null): Player {
  return save({ ...loadPlayer(), name });
}

export function setPlayerTeam(team: Team): Player {
  return save({ ...loadPlayer(), team });
}

/**
 * Where the next run begins: straight into play once the player has a name and a team, else
 * the setup screen. A player from before teams has a name, so setup asks only for the team,
 * once: one tap stores it. A stress run needs neither.
 */
export function nextScreen(player: Player, stress: boolean): "setup" | "play" {
  return stress || (player.name !== null && player.team !== null) ? "play" : "setup";
}

/** For tests: forget the player kept in memory, as a fresh page load would. */
export function forgetPlayerForTests(): void {
  memory = null;
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
