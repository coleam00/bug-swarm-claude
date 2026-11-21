import type { Hono } from "hono";
import type { Rooms } from "./rooms";

/**
 * GET /api/arena/stats: the open arenas with their people (`players`) and fill bots (`bots`),
 * the totals of each, and tick p50/p95 in ms over the last minute. Registered before servePages, whose
 * catch-all would otherwise answer it.
 */
export function mountArenaRoutes(app: Hono, rooms: Rooms): void {
  app.get("/api/arena/stats", (c) => c.json(rooms.stats()));
}
