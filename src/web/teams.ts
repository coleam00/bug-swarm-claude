import type { Team } from "../server/rules";

// How each team reads on screen: its label and its colour (owner ruling: Tabs orange, Spaces teal).
export const TEAM_LOOK: Record<Team, { label: string; color: string }> = {
  tabs: { label: "Tabs", color: "#ff9f43" },
  spaces: { label: "Spaces", color: "#2ed3c6" },
};
