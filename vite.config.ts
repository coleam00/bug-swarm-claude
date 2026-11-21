import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the UI runs on Vite (5173) and calls the API server on PORT (3000).
// Three pages: the game (index.html), the stream board (board.html, served at /board) and the
// arena (arena.html, served at /arena, with its WebSocket at /ws). They sit at the root because
// that is where Vite's dev server looks for /board and /arena.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        board: fileURLToPath(new URL("./board.html", import.meta.url)),
        arena: fileURLToPath(new URL("./arena.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      "/health": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      // The arena's WebSocket (src/server/arena/sockets.ts).
      "/ws": { target: `ws://127.0.0.1:${process.env.PORT ?? 3000}`, ws: true },
      // The icons and the link preview are drawn by the server (src/server/art.ts).
      "/favicon.svg": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      "/favicon.ico": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      "/apple-touch-icon.png": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
      "/og.png": `http://127.0.0.1:${process.env.PORT ?? 3000}`,
    },
  },
});
