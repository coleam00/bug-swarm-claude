// Only production (the container) listens on all interfaces: there Railway's router
// has to reach the app from outside, while a developer's laptop on a shared network
// should not be reachable. Takes env as a parameter because bun test sets NODE_ENV.
export function listenConfig(env: Record<string, string | undefined>): { port: number; hostname: string } {
  const port = Number(env.PORT ?? 3000);
  const hostname = env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1";
  return { port, hostname };
}
