# One exact Bun, the one CI (.github/workflows/ci.yml) and the factory run: a floating tag
# would let a Bun patch release land with any merge (#110).
FROM oven/bun:1.4.5
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Set after install and build so devDependencies (vite, typescript) are installed.
# Production listens on all interfaces (src/server/listen.ts). PORT and DATA_DIR come
# from the platform; DATA_DIR must point at a mounted persistent volume, and in production
# the server refuses to start without it (the image's own data/ is wiped on every redeploy).
# ADMIN_TOKEN (optional, 16+ characters) turns on the owner's /api/admin/* routes
# (src/server/admin.ts, engineering.md "Live operations").
ENV NODE_ENV=production
EXPOSE 3000
# The server itself, not `bun run start`: as PID 1 it gets the platform's SIGTERM directly and
# saves every life in progress before it exits (src/server/main.ts).
CMD ["bun", "src/server/main.ts"]
