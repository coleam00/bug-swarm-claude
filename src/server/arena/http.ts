import type { Hono } from "hono";
import type { Rooms } from "./rooms";

/**
 * GET /api/arena/stats: the open arenas with their players (bots 0 until server bots exist), the
 * total, and tick p50/p95 in ms over the last minute. Registered before servePages, whose
 * catch-all would otherwise answer it.
 */
export function mountArenaRoutes(app: Hono, rooms: Rooms): void {
  app.get("/api/arena/stats", (c) => c.json(rooms.stats()));
}
