# Memcard

**Memcard is a self-hostable cloud-save service.** It stores one state object per
player in Amazon S3 and protects concurrent writes with optimistic concurrency
control built on S3 ETags and standard HTTP conditional requests (`If-Match`,
`If-None-Match`). Point your game or app at Memcard and let it own the S3 plumbing,
conflict detection, and auth verification for you.

- **Clients never touch S3 directly** — every read and write flows through Memcard.
- **Optimistic concurrency** — on fetch the client gets the current state and its
  `ETag`; on save it sends that `ETag` back, and a stale write is rejected with
  `409 Conflict` instead of silently overwriting newer data.
- **Bring your own auth** — Memcard is **issuer-agnostic**. It only **verifies**
  RS256 JWTs against whatever JWKS you point it at; it never issues tokens. Any
  standards-compliant provider works — Auth0, AWS Cognito, Keycloak, Firebase Auth,
  your own service, etc. You only need to set `JWKS_URI` and `JWT_ISSUER`. (No auth
  provider yet? The [dev stack](#local-development-stack-with-auth) suggests a tiny
  one you can spin up locally — but it's optional and easily swapped out.)

---

## Table of contents

- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [API reference](#api-reference)
- [Local development stack (with auth)](#local-development-stack-with-auth)
- [Configuration](#configuration)
- [Development](#development)
- [Project layout](#project-layout)
- [Operational notes](#operational-notes)
- [Contributing](#contributing)
- [License](#license)

---

## How it works

| Layer | Role |
| --- | --- |
| Client (game / app) | Fetches, modifies, and saves state; owns conflict-resolution UX |
| **Memcard** | Verifies JWTs, mediates state access, enforces conditional writes |
| Amazon S3 | Stores the canonical state objects; enforces ETag conditional semantics |

State lives as one object per player at:

```
s3://$MEMCARD_S3_BUCKET/$MEMCARD_KEY_PREFIX/{env}/{app}/{userId}/state.json
```

where `{env}` is fixed per deployment (`MEMCARD_ENV`), `{app}` comes from the JWT
app claim, and `{userId}` is the JWT `sub`. ETags are opaque — never parsed, only
compared and echoed.

When a client saves with a stale ETag, S3 returns `412 Precondition Failed` and
Memcard translates it into a domain-level `409 STATE_CONFLICT` carrying the current
ETag, so the client can re-fetch, merge, and retry. A brand-new player sends the
sentinel ETag (`"0"`), which Memcard turns into a create-only `If-None-Match: *`
write so two devices can't both "create" the first save.

---

## Getting started

### Prerequisites

- **Node.js 24+** and **Yarn** (the repo is yarn-based; Docker uses Corepack).
- **An S3 bucket** Memcard can read and write. For a zero-AWS local trial you can
  point Memcard at [LocalStack](https://localstack.cloud) instead (see below).
- **Any JWT issuer that publishes a JWKS.** This is wherever your users already
  sign in — Memcard does not prescribe one. It verifies RS256 tokens whose `sub` is
  the player id and whose app claim (`JWT_APP_CLAIM`, default `app`) names the
  game/app; point `JWKS_URI` / `JWT_ISSUER` at your provider and you're done.
  Just experimenting and have no provider? The
  [dev stack](#local-development-stack-with-auth) *suggests* a ready-to-run issuer
  you can use locally, but it is in no way required.

### 1. Install

```bash
git clone https://github.com/GiganticPlayground/memcard.git
cd memcard
yarn install
```

### 2. Configure

```bash
cp .env.example .env
```

Then set the **required** values in `.env`:

| Variable | Example | What it is |
| --- | --- | --- |
| `AWS_REGION` | `us-east-1` | Region of your bucket |
| `MEMCARD_S3_BUCKET` | `my-game-saves` | Bucket that holds state objects |
| `MEMCARD_ENV` | `prod` | `{env}` segment of the S3 key |
| `JWKS_URI` | `https://auth.example.com/.well-known/jwks.json` | Where Memcard fetches public keys to verify tokens |
| `JWT_ISSUER` | `https://auth.example.com` | Expected `iss` claim |

AWS credentials are resolved through the **default AWS SDK credential chain**
(environment variables, shared config, or an IAM role in deployment) — you do not
put secrets in `.env`. See [Configuration](#configuration) for every variable.

> **Trying it out without AWS?** Run LocalStack, create a bucket, and add
> `MEMCARD_S3_ENDPOINT=http://localhost:4566` and `MEMCARD_S3_FORCE_PATH_STYLE=true`
> to `.env`.

### 3. Run

```bash
yarn dev      # hot-reload dev server (nodemon + tsx)
# or
yarn start    # run once
```

Memcard fails fast on startup if any required variable is missing or invalid.
Confirm it's up:

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"...","service":"memcard"}
```

Interactive API docs (Swagger UI) are served at `http://localhost:3000/api-docs`
unless you set `API_DOCS_ENABLED=false`.

### 4. Make your first calls

Every `/v1/memcard` call needs a valid `Bearer` token from your issuer. With a
token in `$TOKEN`:

```bash
# Fetch state — a new player gets an empty state and the sentinel ETag "0"
curl -i http://localhost:3000/v1/memcard/me/state \
  -H "Authorization: Bearer $TOKEN"

# Save state — first write uses the sentinel ETag "0" in If-Match
curl -i -X PUT http://localhost:3000/v1/memcard/me/state \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'If-Match: 0' \
  -d '{"state":{"level":1,"coins":100}}'
```

The save response returns `{"success":true}` and an `ETag` header — use that ETag
in the next save's `If-Match`. If you don't have an issuer yet, jump to the
[local dev stack](#local-development-stack-with-auth), which mints tokens for you.

---

## API reference

Routes are defined by the OpenAPI spec in [api/openapi.yaml](api/openapi.yaml) and
dispatched through `express-openapi-validator` — there is no manual router.

| Method & path | Purpose |
| --- | --- |
| `GET /v1/memcard/me/state` | Fetch the authenticated player's state |
| `PUT /v1/memcard/me/state` | Save the authenticated player's state |
| `GET /health` | Liveness check |
| `GET /api-docs` | Swagger UI _(disabled when `API_DOCS_ENABLED=false`)_ |

### `GET /v1/memcard/me/state`

```
GET /v1/memcard/me/state
Authorization: Bearer <jwt>
If-None-Match: "etag-123"   # optional, for cache revalidation
```

- **200 OK** — `ETag` header + body `{ "lastModified": "...", "state": { ... } }`
- **304 Not Modified** — when `If-None-Match` matches the stored ETag (no body)
- **401** — missing, expired, or invalid token
- A player with no stored state gets an empty `state` and the sentinel ETag (`"0"`).

> The current ETag is returned **only** in the `ETag` response header, not in the body.

### `PUT /v1/memcard/me/state`

```
PUT /v1/memcard/me/state
Authorization: Bearer <jwt>
If-Match: "etag-123"
Content-Type: application/json

{ "state": { "level": 2, "coins": 250 } }
```

- **200 OK** — `ETag` header with the newly issued version + body `{ "success": true }`
- **409 Conflict** — `ETag` header + body `{ "errorCode": "STATE_CONFLICT", "currentEtag": "..." }`
  when the supplied ETag is stale
- **413 Payload Too Large** — body exceeds `MEMCARD_MAX_BODY_BYTES`
- **401** — missing, expired, or invalid token

`If-Match` is **required**. A new player sends the sentinel ETag (`"0"`), which
Memcard translates into a create-only `If-None-Match: *` write. On a `409`, re-fetch
with `GET` before surfacing a conflict to the user.

---

## Local development stack (with auth)

> **Optional convenience, not a dependency.** Memcard works with any JWKS-publishing
> issuer (see [Bring your own auth](#how-it-works)). If you already have a provider,
> just set `JWKS_URI` / `JWT_ISSUER` and skip this section. It exists only so people
> *without* an auth service can still try Memcard end-to-end on their machine.

As a **suggested** local setup, this repo's `docker-compose.dev.yml` runs Memcard
alongside [Token Weaver](https://github.com/GiganticPlayground/token-weaver) — a small, separate auth service that
issues the JWTs Memcard verifies — on one network. Token Weaver is one example of a
suitable issuer; you're free to substitute any other.

**This stack is self-contained** — you do **not** need to clone or build Token
Weaver. It runs from its published image
(`ghcr.io/giganticplayground/token-weaver:latest-main`) and reads its config from
this repo's [`dev/token-weaver/`](dev/token-weaver/), which holds a ready-made
strategy file ([`token-weaver.yaml`](dev/token-weaver/token-weaver.yaml)) defining
test players. The only thing not committed is the RSA signing key (a dev-only
secret), which you generate locally in one command.

### Run it

```bash
# 1. Generate the dev RSA signing key (once; written to dev/token-weaver/keys/,
#    which is gitignored). Token Weaver signs JWTs with it and publishes the
#    matching public key via its JWKS.
yarn dev:keys

# 2. Make sure .env has your AWS settings (AWS_REGION, MEMCARD_S3_BUCKET,
#    MEMCARD_ENV) — Memcard still reads/writes a real bucket.

# 3. Bring up both services
docker compose -f docker-compose.dev.yml up -d --build

# ...and tear them down when done
docker compose -f docker-compose.dev.yml down
```

How it's wired:

- **Token Weaver** is pulled from GHCR (not built); **Memcard** is built locally
  from this repo, so `--build` applies to Memcard.
- Token Weaver → host `:3000`, Memcard → host `:3010`.
- Memcard reaches Token Weaver over the compose network at
  `http://token-weaver:3000/.well-known/jwks.json`.
- AWS credentials, region, and bucket are read from `.env`; the compose file
  overrides `JWKS_URI` / `JWT_ISSUER` / `PORT` for the container network and mounts
  `./dev/token-weaver` into Token Weaver at `/app/config`.

> **Test players.** The vendored [`token-weaver.yaml`](dev/token-weaver/token-weaver.yaml)
> defines several players you can swap between by changing the `secret` you send:
> `dev-secret` → `player-001`, `secret-player-002` → `player-002`, … through
> `player-005` (all under app `my-game`). Each player is an independent state object
> in S3, so switching player gives you a clean slate to demo the full flow.
>
> ⚠️ These secrets and the dev RSA key are for **local use only** — never reuse them
> in a reachable environment.

Mint a token and call Memcard (use `127.0.0.1` for Memcard — `localhost` may
resolve to IPv6, which the container's port binding does not answer on):

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/auth/game-client \
  -H 'Content-Type: application/json' -d '{"secret":"dev-secret"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -i http://127.0.0.1:3010/v1/memcard/me/state -H "Authorization: Bearer $TOKEN"
curl -i -X PUT http://127.0.0.1:3010/v1/memcard/me/state \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'If-Match: 0' -d '{"state":{"coins":100}}'
```

A ready-made Postman collection for this flow lives in [postman/](postman/).

---

## Configuration

Configuration is **environment-only** and validated by a Zod schema at startup
(`src/config/env.validation.ts`); the app refuses to boot on missing or invalid
values.

| Variable | Default | Used for |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | Application environment mode |
| `LOG_LEVEL` | `debug` | Minimum log level for the `logra` logger |
| `LOG_TYPE` | `pretty` | Logger output: `pretty`, `json`, or `hidden` |
| `CORS_ORIGINS` | unset | Allowed CORS origins; unset or `*` allows all |
| `TRUST_PROXY` | `false` | Express trust proxy setting for forwarded headers / client IP |
| `RATE_LIMIT_ENABLED` | `false` | Enables IP-based rate limiting on `/v1/memcard` |
| `RATE_LIMIT_MAX` | `30` | Max requests per window per client IP |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length (ms) |
| `AWS_REGION` | _required_ | AWS region of the bucket |
| `MEMCARD_S3_BUCKET` | _required_ | S3 bucket holding state objects |
| `MEMCARD_ENV` | _required_ | `{env}` segment of the S3 key |
| `MEMCARD_KEY_PREFIX` | `memcard` | Key prefix |
| `MEMCARD_MAX_BODY_BYTES` | `2097152` | Max PUT body size before `413` |
| `MEMCARD_SENTINEL_ETAG` | `0` | Sentinel ETag for first-write bootstrap |
| `MEMCARD_SCHEMA_VERSION` | `1` | `schemaVersion` written into the stored envelope |
| `MEMCARD_S3_TIMEOUT_MS` | `5000` | Per-request S3 timeout (→ `503` on timeout) |
| `MEMCARD_S3_ENDPOINT` | unset | Explicit S3 endpoint (e.g. LocalStack) |
| `MEMCARD_S3_FORCE_PATH_STYLE` | `false` | Force path-style S3 addressing |
| `JWKS_URI` | _required_ | Auth service JWKS endpoint used to verify tokens |
| `JWT_ISSUER` | _required_ | Expected `iss` claim |
| `JWT_AUDIENCE` | unset | Expected `aud` claim (when set) |
| `JWT_APP_CLAIM` | `app` | Claim that supplies the `{app}` key segment |
| `API_DOCS_ENABLED` | `true` | Mounts Swagger UI at `/api-docs` |
| `SHUTDOWN_TIMEOUT_MS` | `30000` | Max wait for in-flight requests on SIGTERM/SIGINT |

---

## Development

```bash
yarn dev          # nodemon + tsx, hot reload
yarn start        # run once via tsx
yarn test         # node:test unit suite (tests/**/*.test.ts)
yarn validate     # type-check + lint + format:check — run before opening a PR
yarn lint         # eslint (lint:fix to autofix)
yarn format       # prettier --write
yarn build        # tsc → dist/ (+ ESM import-extension fix)
yarn gen-types    # regenerate src/types/schema.d.ts from the OpenAPI spec
```

`api/openapi.yaml` is the source of truth for routes and types. After editing it,
run `yarn gen-types`. To add an endpoint, add it to the spec and create the matching
controller export (binding is by the `x-eov-operation-handler` /
`x-eov-operation-id` extensions — there is no router file).

---

## Project layout

- [src/middlewares/auth.middleware.ts](src/middlewares/auth.middleware.ts) — JWT verification via remote JWKS
- [src/services/memcard.service.ts](src/services/memcard.service.ts) — domain logic, key construction, size enforcement
- [src/services/s3.service.ts](src/services/s3.service.ts) — conditional S3 read/write and ETag mapping
- [src/controllers/memcardController.ts](src/controllers/memcardController.ts) — GET/PUT handlers
- [src/config/env.validation.ts](src/config/env.validation.ts) — environment schema (fail-fast at startup)
- [api/openapi.yaml](api/openapi.yaml) — API contract (routes, request/response types)

---

## Operational notes

- Credential failures and invalid/expired tokens return `401` **before** any S3 access.
- Upstream S3 timeouts/unavailability return `503`.
- Out of scope (handle with your IaC): bucket provisioning, object versioning +
  lifecycle, IAM least-privilege, encryption at rest.
- The in-process rate limiter is per-instance; back it with a shared store (e.g.
  Redis) when scaling horizontally.

---

## Contributing

Contributions are welcome! Please:

1. Fork the repo and create a feature branch.
2. Make your change, keeping the OpenAPI spec the source of truth (run
   `yarn gen-types` after editing `api/openapi.yaml`).
3. Run `yarn validate` and `yarn test` — both must pass.
4. Open a pull request describing the change and the motivation.

---

## License

Released under the [MIT License](LICENSE).
