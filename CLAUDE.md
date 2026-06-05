# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Memcard — a mobile state-persistence (cloud save) service. It stores one state object per player in Amazon S3 and enforces optimistic concurrency with S3 ETags and HTTP conditional requests (`If-Match` / `If-None-Match`). Mobile clients never touch S3 directly; Memcard mediates every read and write.

Memcard **verifies** JWTs issued by a separate auth service (e.g. Token Weaver) — it never issues them. The scaffolding (Express + OpenAPI-first + Zod config + middlewares + Docker + node:test) was adapted from a Token Weaver template; if you find lingering `token-weaver` references, they are vestigial.

## Conventions (enforced — see `.claude/rules.md`)

- **Use `yarn`, not `npm`** for installing packages and running scripts. The repo is yarn-based (`yarn.lock`, Docker uses `corepack`/yarn). `package.json` scripts spell commands as `npm run …` internally, but invoke them via yarn (`yarn validate`, `yarn dev`).
- **No file extensions in relative imports** (`import { x } from './bar'`). `moduleResolution: "bundler"` resolves them; the build re-adds `.js` for runtime (see below).
- ESM throughout (`"type": "module"`), run directly with `tsx` in dev.

## Commands

```bash
yarn dev              # nodemon + tsx, hot reload
yarn start            # run once via tsx
yarn validate         # type-check + lint + format:check — run before considering work done
yarn test             # node:test suite (tests/**/*.test.ts)
yarn lint             # eslint src tests; lint:fix to autofix
yarn format           # prettier --write
```

Run a single test file: `node --import=tsx --test tests/unit/s3.service.test.ts`

### OpenAPI codegen

`api/openapi.yaml` is the source of truth for routes and request/response types.

```bash
yarn gen-types        # regenerate src/types/schema.d.ts from the spec
yarn gen-controllers  # scaffold missing controllers from the spec (skips existing files)
```

After editing `api/openapi.yaml`, run `yarn gen-types`.

### Build

`yarn build` runs `tsc` to `dist/` then `scripts/fix-dist-esm-imports.js`, which appends `.js` extensions to relative imports in the emitted output (source omits them; Node ESM needs them at runtime).

## Architecture

**Request flow** (`src/index.ts`): helmet → cors → `express.json({ limit: MEMCARD_MAX_BODY_BYTES })` → `requestContextMiddleware` → optional Swagger UI (`/api-docs`) → optional rate limit on `/v1/memcard` → **`authMiddleware` on `/v1/memcard`** → `createOpenApiValidatorMiddleware` → `errorHandlerMiddleware`.

**Routing is OpenAPI-driven, not manually registered.** `express-openapi-validator` validates each request against `api/openapi.yaml` and dispatches to a controller export. Binding is by spec extensions: `x-eov-operation-handler` names the file in `src/controllers/`, `x-eov-operation-id` names the exported function. There is no router file — to add an endpoint, add it to the spec and create the matching controller export. Because dispatch is by method **and** path, `GET` and `PUT` on the same path are separate operations (no manual method routing needed).

**Auth before S3.** `authMiddleware` (`src/middlewares/auth.middleware.ts`) verifies the bearer JWT against a remote JWKS (`jose` `createRemoteJWKSet`, RS256), then attaches `req.auth = { userId, app }` (typed via `src/types/express.d.ts`). `userId` is the JWT `sub`; `app` is the `JWT_APP_CLAIM` claim. Invalid/expired/missing tokens → `401` before any S3 call.

**Service layering:**
- `MemcardService` (`src/services/memcard.service.ts`) — builds the S3 key `${MEMCARD_KEY_PREFIX}/${MEMCARD_ENV}/${app}/${userId}/state.json`, wraps the client `state` in the stored envelope (`schemaVersion`, `lastModifiedAt`), enforces the byte-size limit (`413`), and assembles the response envelope.
- `S3StateStore` (`src/services/s3.service.ts`) — the only place that talks to S3 (`@aws-sdk/client-s3`). Maps S3 conditional semantics onto the domain: `If-None-Match` → `304`; missing object → sentinel ETag + empty state; `If-Match` write, with the sentinel translated to create-only `If-None-Match: *`; `412 Precondition Failed` → `HeadObject` re-read → `StateConflictError(409, currentEtag)`; timeouts/5xx/no-response → `UpstreamUnavailableError(503)`.
- Both are wired as a singleton in `src/services/index.ts`.

**ETags are opaque** end to end — only compared and echoed, never parsed.

## Configuration

Environment is validated by a Zod schema (`src/config/env.validation.ts`) at module import via `config = validateEnv()` — the app **fails fast on startup** if vars are missing/invalid. Import the validated, typed config from `src/config/index`. Required: `AWS_REGION`, `MEMCARD_S3_BUCKET`, `MEMCARD_ENV`, `JWKS_URI`, `JWT_ISSUER`. See `README.md` / `.env.example` for the full set. There is no YAML config file — configuration is env-only. AWS credentials come from the default SDK credential chain (IAM role).

## Error handling

Throw `HttpError(status, message, { code })`, `StateConflictError(currentEtag)` (→ `409` with `{ errorCode: 'STATE_CONFLICT', currentEtag }`), `PayloadTooLargeError` (→ `413`), or `UpstreamUnavailableError` (→ `503`) from `src/utils/http-error.ts`. `errorHandlerMiddleware` (`src/middlewares/error.middleware.ts`) renders them: the conflict case emits the domain body; the body parser's own `413` is also handled; 4xx include `message`/`code`; everything else is `500`.

## Tests

`node:test` with `@aws-sdk/client-s3` mocked via `aws-sdk-client-mock` (S3 stream bodies built with `@smithy/util-stream`). `tests/setup-env.ts` is imported **first** in each test to populate required env vars before the config module validates them at import time. Coverage focuses on `S3StateStore` (200/304/sentinel/timeout/conflict/sentinel-write) and `MemcardService` (key building, envelope wrapping, size limit).

## Gotchas

- **`logra` is a GitHub dependency that builds via its `prepare` script.** A clean `yarn install` builds it; an incremental `yarn add` may leave `node_modules/logra/dist` empty, causing `Cannot find module 'logra/dist/index.js'`. Fix: `node_modules/.bin/tsc -p node_modules/logra/tsconfig.json` (or reinstall cleanly).
- **`token-weaver` (the `token-weaver/auth` middleware) is also a GitHub dependency built by `prepare`** (its `build:lib` → `tsconfig.lib.json`, auth lib only). Same gotcha as logra: yarn classic does not reliably run a git-dep `prepare`, so its `dist/` may be missing after install. Fix: `node_modules/.bin/tsc -p node_modules/token-weaver/tsconfig.lib.json && node node_modules/token-weaver/scripts/fix-dist-esm-imports.js node_modules/token-weaver/dist`. The `Dockerfile` builds both logra and token-weaver explicitly for this reason.
- `tsconfig` has `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on — index access is `T | undefined`, and optional props that may be explicitly `undefined` must be typed `?: T | undefined`.
