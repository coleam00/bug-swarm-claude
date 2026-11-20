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
CMD ["bun", "run", "start"]
