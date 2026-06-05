# Memcard - Docker Image
# Build TypeScript ahead of time and run the compiled output with Node.js

FROM node:24-slim AS base

# Install runtime dependencies used by the app and healthcheck
RUN apt-get update && apt-get install -y \
  openssl \
  ca-certificates \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

FROM base AS builder

# Copy manifest and lockfile first for better Docker layer caching
COPY package.json yarn.lock ./

# Install all dependencies required for the build
RUN yarn install --frozen-lockfile

# logra is a Git dependency built by its `prepare` script. A clean install
# normally builds it, but in some CI environments its dist/ (with the .d.ts
# files) is not materialized, which makes the `yarn build` below fail with
# "Cannot find module 'logra'". Build it explicitly with our own tsc so the
# types are always present, regardless of whether `prepare` ran.
RUN node_modules/.bin/tsc -p node_modules/logra/tsconfig.json

# token-weaver is also a Git dependency consumed as a library (`token-weaver/auth`).
# Its `prepare` builds only the auth lib (tsconfig.lib.json), but yarn classic does
# not reliably run a git-dep `prepare`, so build it explicitly here. The two-step
# build mirrors the package's own `build:lib` (tsc + the .js ESM-extension fixup).
RUN node_modules/.bin/tsc -p node_modules/token-weaver/tsconfig.lib.json \
  && node node_modules/token-weaver/scripts/fix-dist-esm-imports.js node_modules/token-weaver/dist

# Copy source code and configuration files, then build
COPY . .
RUN yarn build

FROM base AS runtime

# Copy manifest and lockfile first for better Docker layer caching
COPY package.json yarn.lock ./

# Install only production dependencies for runtime
RUN yarn install --frozen-lockfile --production

# logra is a Git dependency built by its `prepare` script; a --production
# install does not rebuild it, so graft the version already built in the
# builder stage (which ran a full install).
COPY --from=builder /app/node_modules/logra ./node_modules/logra

# token-weaver/auth is imported at runtime; graft the lib build (dist/) from the
# builder stage for the same reason as logra (--production won't build it).
COPY --from=builder /app/node_modules/token-weaver ./node_modules/token-weaver

# Copy the built application and required runtime assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/api ./api

# Expose the port the app runs on
EXPOSE 3000

# Change ownership of the app directory
RUN chown -R node:node /app
USER node

# Health check to verify the application is running
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=40s \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the compiled application
CMD ["node", "dist/src/index.js"]
