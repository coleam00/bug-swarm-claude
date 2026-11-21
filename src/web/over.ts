import type { UpgradeId } from "../server/rules";
import { UPGRADES } from "./game/config";

export type UpgradeLevel = { id: UpgradeId; name: string; level: number };

/**
 * How the run was built, for the game-over screen: each upgrade taken, in the order first
 * taken, at the level it reached (one level a pick).
 */
export function upgradeLevels(taken: readonly UpgradeId[]): UpgradeLevel[] {
  const levels: UpgradeLevel[] = [];
  for (const id of taken) {
    const known = levels.find((l) => l.id === id);
    if (known) known.level++;
    else levels.push({ id, name: UPGRADES[id].name, level: 1 });
  }
  return levels;
}
