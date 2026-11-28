// Every pickup's draw functions, by pickup id (#73). The Record makes TypeScript demand an entry
// for each id in PICKUP_IDS, so no pickup reaches the screen undrawn.
import type { PickupId } from "../../../../shared/arena/constants";
import { bombDraw } from "./bomb";
import { cloakDraw } from "./cloak";
import { droneDraw } from "./drone";
import type { PickupDraw } from "./kind";
import { laserDraw } from "./laser";
import { shieldDraw } from "./shield";

export const PICKUP_DRAW: Record<PickupId, PickupDraw> = { shield: shieldDraw, laser: laserDraw, bomb: bombDraw, drone: droneDraw, cloak: cloakDraw };
