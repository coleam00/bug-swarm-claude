FROM oven/bun:1.4
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# Set after install and build so devDependencies (vite, typescript) are installed.
# Production listens on all interfaces (src/server/listen.ts). PORT and DATA_DIR come
# from the platform; DATA_DIR must point at a mounted persistent volume.
ENV NODE_ENV=production
EXPOSE 3000
# The server itself, not `bun run start`: as PID 1 it gets the platform's SIGTERM directly and
# saves every life in progress before it exits (src/server/main.ts).
CMD ["bun", "src/server/main.ts"]
