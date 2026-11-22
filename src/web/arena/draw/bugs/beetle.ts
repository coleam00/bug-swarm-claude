// The beetle (#80): a big, slow, steel-blue bug with a shell over its front 120 degrees. Every
// player sees which way its shell faces: a beetle is never in phase 0 once it has stepped, so its
// facing rides every snapshot row's tail (and turns smoothly between snapshots, game.ts).
import { BEETLE_RADIUS } from "../../../../shared/arena/bugs/beetle";
import { GLOW_STEEL, type BugLook } from "../../../game/look";
import type { BugsView } from "../../render";
import { drawBody } from "./body";
import type { BugDraw, BugFrame } from "./kind";

const look: BugLook = {
  // Drawn much bigger than its 12-unit collision radius: a big, armoured bug.
  radius: BEETLE_RADIUS * 1.7,
  shell: "#4b6a8a",
  shine: "#9fb8d0",
  head: "#1e2a38",
  legs: "#cbd5e1",
  glow: GLOW_STEEL,
  legHz: 2,
  legSwing: 0.3,
  jitter: 0,
  jitterHz: 0,
};

function draw(f: BugFrame, view: BugsView, i: number): void {
  // It faces its facing exactly: the shell is where it points.
  const angle = view.phase[i] === 0 ? NaN : view.angle[i]!;
  drawBody(f, look, view, i, 1, 1, 1, 1, angle);
}

export const beetleDraw: BugDraw = { look, draw };
