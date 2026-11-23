// Only production (the container) listens on all interfaces: there Railway's router
// has to reach the app from outside, while a developer's laptop on a shared network
// should not be reachable. Takes env as a parameter because bun test sets NODE_ENV.
export function listenConfig(env: Record<string, string | undefined>): { port: number; hostname: string } {
  const port = Number(env.PORT ?? 3000);
  const hostname = env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  return { port, hostname };
}

/**
 * Where the database lives. In production DATA_DIR is required: the image's own data/ folder is
 * wiped on every redeploy, so falling back to it would silently empty the board (#110). Elsewhere
 * it defaults to data/. Empty or blank counts as unset.
 */
export function dataDirFrom(env: Record<string, string | undefined>): { dataDir: string } | { error: string } {
  const dir = env.DATA_DIR?.trim() ?? "";
  if (dir) return { dataDir: dir };
  if (env.NODE_ENV === "production") {
    return {
      error:
        "DATA_DIR is not set: in production the server refuses to start, because the image's data/ folder is wiped on every redeploy. Point DATA_DIR at the mounted volume.",
    };
  }
  return { dataDir: "data" };
}
