import { checkName } from "../server/rules";

// Who is playing: a random id this browser makes on its first visit, and the name they picked.
// Kept in localStorage; where that is unavailable (private mode, blocked storage) it lives in
// memory for this page only.
export type Player = { id: string; name: string | null };

const KEY = "bugswarm.player";
let memory: Player | null = null;

/** The stored player, else the one kept in memory, else a new one. A stored invalid name is dropped. */
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
  return save({ id, name });
}

export function setPlayerName(name: string | null): Player {
  return save({ ...loadPlayer(), name });
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
