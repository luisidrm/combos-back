# One image for the API, the worker and the migration job: they are the same code with a different command
# (docker-compose.prod.yml sets it). Build from the back/ folder:  docker build -t combo-shop-api .

# --- dependencies (cached until package*.json changes) -------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --fetch-retries=6 --fetch-retry-mintimeout=3000 --fetch-timeout=120000

# --- build: compile TypeScript (tests and the demo seed are excluded by tsconfig.build.json), then drop dev deps ---
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime ---------------------------------------------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The SQL migrations and their journal: applied by `node dist/db/migrate.js` (see src/db/migrate.ts).
COPY src/db/migrations ./src/db/migrations
USER node
EXPOSE 4000
# Run directly, not through npm, so SIGTERM reaches Node and it can finish what it is doing.
CMD ["node", "dist/main.js"]
