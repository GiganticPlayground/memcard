# Requirement: Dual-mode JWT validation (JWKS / RS256 and secret / HS256)

> Status: **Ready to implement (Option B preferred)** — the token-weaver shared
> middleware now exists, is tested, and is consumable. What remains is the Memcard
> consumer-side change. See "Current status" below.

## Current status (2026-06)

- **token-weaver lib: DONE.** `createAuthMiddleware` is implemented and published
  via the `token-weaver/auth` subpath (`v1.0.2`), with an optional authz layer and
  an env helper — see Option B.
- **Memcard consumer: DONE (Option B).** `src/middlewares/auth.middleware.ts` now
  delegates to `token-weaver/auth`; `JWT_AUTH_MODE` (`jwt-jwks` | `jwt-hs256`),
  `JWT_SECRET`, and a conditional `JWKS_URI` were added to the Zod config; tests +
  README + `.env.example` updated. `yarn validate` + `yarn test` green.
- **token-weaver lib-only build: DONE (`v1.0.3`).** The published build now compiles
  only `src/auth` (`tsconfig.lib.json`), so it no longer needs `logra`/the server.
  Verified by a clean isolated `npm install` (builds `dist/src/auth`, no server, no
  manual step). Spec: `token-weaver/docs/lib-build-isolation.md`. Memcard pins
  `#semver:^1.0.0` and now resolves `v1.0.3`.
- **CI/Docker: DONE.** yarn classic still doesn't run a git-dep `prepare`, so the
  `Dockerfile` builds `token-weaver` explicitly (like `logra`) and grafts its `dist/`
  into the runtime stage. Verified end-to-end: full `docker build` succeeds and
  `import 'token-weaver/auth'` resolves inside the runtime image. The same logra-style
  manual build is needed after a local `yarn install` (documented in `CLAUDE.md`).

> ⚠️ **Mode identifiers were finalized in token-weaver as
> `jwt-jwks` | `jwt-hs256` | `static`** (not `jwks`/`secret`). This doc's prose
> still uses "jwks/secret" to describe the *concepts*; the literal library values
> are the `jwt-` prefixed ones.

## Summary

Memcard's auth middleware currently verifies inbound JWTs **only** against a
remote JWKS using RS256 (asymmetric, public-key) verification. We need it to
**also** support secret-based (HS256, symmetric, shared-secret) verification, so
operators can choose the validation mode that fits their issuer.

The selected mode determines how the verification key is built and which
algorithm(s) are accepted:

| Mode               | Verification key                            | Algorithm | Use case                                             |
| ------------------ | ------------------------------------------- | --------- | ---------------------------------------------------- |
| `jwks` (current)   | `createRemoteJWKSet(JWKS_URI)`              | `RS256`   | Issuer publishes a JWKS endpoint (e.g. Token Weaver) |
| `secret` (new)     | `new TextEncoder().encode(<shared secret>)` | `HS256`   | Issuer signs with a shared secret; no JWKS endpoint  |
| `static` (stretch) | constant-time compare to a fixed token      | —         | Trusted internal callers / smoke tests (no JWT)      |

Exactly one mode is active per deployment. (`static` is included because the
reference middleware and the bonus shared-library option below support it; it is
optional for Memcard.)

## Motivation

- Not every issuer exposes a JWKS endpoint. A symmetric shared secret (HS256) is
  a common, simpler setup for smaller deployments and internal tooling.
- Keeps Memcard issuer-agnostic: it remains a pure JWT **verifier** and does not
  prescribe how tokens are issued.

## Reference implementation

`GiganticPlayground/ipb-nexus` already does this in
`src/middlewares/jwt-auth.middleware.ts`. The relevant pattern:

```ts
// Key + algorithm are chosen by the configured auth mode:
const { payload } =
  auth.type === 'jwks'
    ? await jwtVerify(token, auth.jwks, baseOptions)                       // RS256 via JWKS
    : await jwtVerify(token, auth.secret, { ...baseOptions, algorithms: ['HS256'] }); // HS256 via secret
```

Key construction (in its config layer):

- `jwks` → `createRemoteJWKSet(new URL(jwks_url), { ... })`
- `hs256` → `secret: new TextEncoder().encode(secret)` (a `Uint8Array`)

`baseOptions` carries the shared `issuer` and optional `audience`; only the
algorithm list and the key differ between modes.

> Note: ipb-nexus also layers on scope/claim and path allow/deny checks. Those
> are **out of scope** for this requirement — Memcard only needs the dual-mode
> key/algorithm selection. Memcard keeps its existing `sub` → `userId` and
> `JWT_APP_CLAIM` → `app` mapping unchanged.

## Current state (what exists today)

- `src/middlewares/auth.middleware.ts`
  - Builds a module-level `const jwks = createRemoteJWKSet(new URL(config.JWKS_URI))`.
  - `verifyOptions` hardcodes `algorithms: ['RS256']`, plus `issuer` and optional `audience`.
  - On success, maps `payload.sub` → `req.auth.userId` and `payload[JWT_APP_CLAIM]` → `req.auth.app`.
- `src/config/env.validation.ts` (Zod, fail-fast at import)
  - `JWKS_URI` is **required** (`z.string().url()`).
  - `JWT_ISSUER` required; `JWT_AUDIENCE` optional; `JWT_APP_CLAIM` defaults to `app`.
  - No symmetric-secret variable exists yet.

## Proposed approach (to be refined)

Two ways to deliver this. **Option A** is the minimal, self-contained change.
**Option B** is the "bonus": extract the verification logic into a shared
middleware published by `token-weaver` and consume it here. They are not
mutually exclusive — Option A can ship first, then be refactored onto Option B.

### Option A — implement inline in Memcard

1. **Config / env** (`src/config/env.validation.ts`)
   - Introduce a mode selector, e.g. `JWT_AUTH_MODE` (`jwks` | `secret`), defaulting
     to `jwks` to preserve current behavior.
   - Add `JWT_SECRET` (the shared HS256 secret), required **only** when mode is `secret`.
   - Make `JWKS_URI` required **only** when mode is `jwks` (today it is always required).
   - Enforce the conditional requirement with a Zod `superRefine`/`refine` so the app
     still **fails fast** on an inconsistent config (e.g. `mode=secret` with no `JWT_SECRET`).

2. **Middleware** (`src/middlewares/auth.middleware.ts`)
   - Build the verification key once at module load based on the mode:
     - `jwks` → `createRemoteJWKSet(...)`, `algorithms: ['RS256']`.
     - `secret` → `new TextEncoder().encode(config.JWT_SECRET)`, `algorithms: ['HS256']`.
   - Keep `issuer` / `audience` options shared across modes.
   - Leave the rest of the flow (`sub`/`app` extraction, 401 handling, error mapping) unchanged.

3. **Docs & examples**
   - Update `.env.example`, the README configuration table, and the local dev stack notes
     to describe both modes and when to use each.

### Option B (bonus) — shared auth middleware published by `token-weaver`

> Goal: write the configurable verification middleware **once** in `token-weaver`,
> publish it as an importable library, and consume it from Memcard (and other
> projects). Also counts as an open-source contribution back to `token-weaver`.
>
> **The token-weaver-side work is specified in its own repo** so a dedicated
> session can implement it: `token-weaver/docs/shared-auth-middleware.md`. The
> notes below are the Memcard-consumer view of that effort.

**Scope guard (per request):** export **only** a reusable auth **middleware
utility** from `token-weaver`. Do **not** export or couple to token-weaver's
issuing/endpoint internals (its OpenAPI operations, services, strategies, etc.).
The library surface is the middleware factory + its types, nothing more.

**Modes the shared middleware supports** (single active mode per consumer) —
final, implemented identifiers:

- `static` — constant-time compare of the bearer value to a configured token.
- `jwt-jwks` — `createRemoteJWKSet(url)` + `algorithms: ['RS256']`.
- `jwt-hs256` — `new TextEncoder().encode(secret)` + `algorithms: ['HS256']`.

**Keep it consumer-agnostic.** The middleware verifies the token, attaches the
decoded payload (`req.jwtPayload`), and calls `next()`. It does **not** know about
Memcard concepts like `userId` / `app`. Memcard passes an `onVerified` hook that
maps `payload.sub` → `req.auth.userId` and `payload[JWT_APP_CLAIM]` → `req.auth.app`.

**Implemented API surface** (`token-weaver/auth`):

```ts
import {
  createAuthMiddleware,        // options-object factory
  createAuthMiddlewareFromEnv, // env-driven helper (AUTH_* vars)
  AuthError,                   // 401 authentication failure
  ForbiddenError,              // 403 authorization failure (authz layer)
} from 'token-weaver/auth';

createAuthMiddleware({
  mode: 'jwt-jwks' | 'jwt-hs256' | 'static',
  issuer, audience?,           // jwt modes
  jwksUri?,                    // mode: 'jwt-jwks'
  secret?,                     // mode: 'jwt-hs256'
  staticToken?,               // mode: 'static'
  onVerified?: (payload, req) => void | Promise<void>,
  // --- optional authorization layer (opt-in; omit for pure authn) ---
  requirements?,              // e.g. [{ type: 'scope', value: 'save:write' }]
  paths?,                     // { pathPrefix?, whitelistClaim?, blacklistClaim? }
})
```

**Optional authorization layer (out of scope for Memcard's first cut).** The
middleware grew an opt-in authz layer ported from `ipb-nexus`: `requirements`
(scope / claim_includes) and `paths` (whitelist/blacklist read from token claims),
emitting `ForbiddenError` (403) distinct from `AuthError` (401). Token-weaver
*issues* those claims via its strategies; the middleware *enforces* them. **Memcard
does not need this initially** — omit `requirements`/`paths` and behavior is pure
authentication. Noted here only as a future capability.

**Packaging work required in `token-weaver`** (it is an app today, not a lib):

1. **Dedicated entry point**, not the server. Add a library entry (e.g.
   `src/auth/index.ts`) and expose it via `package.json`. Mirror logra's manifest,
   which is the working template in this repo:

   ```jsonc
   "main":    "./dist/index.js",
   "types":   "./dist/index.d.ts",
   "files":   ["dist"],
   "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }
   ```

   For token-weaver, prefer a **subpath** export (e.g. `"./auth"`) pointing at the
   middleware entry rather than the root, so importing the lib never pulls the
   server into the graph.
2. **`prepare` build script so a GitHub install builds itself.** When you run
   `npm install github:GiganticPlayground/token-weaver`, npm runs the package's
   `prepare` script after fetching it — that is where the build must happen, so
   consumers get compiled JS + `.d.ts` without committing `dist/`. logra does
   exactly this:

   ```jsonc
   "scripts": {
     "build":   "tsc -p tsconfig.json",
     "prepare": "npm run build"
   }
   ```

   token-weaver's existing `build` also runs `scripts/fix-dist-esm-imports.js`
   after `tsc` (to append `.js` to relative ESM imports) — wire `prepare` to that
   same build so the emitted output is runtime-correct.
   ⚠️ Carry over the documented `logra` gotcha: an **incremental** `npm/yarn add`
   may leave `dist/` empty (`prepare` not re-run) — note the manual
   `tsc -p node_modules/<pkg>/tsconfig.json` rebuild fallback, and that the Memcard
   Dockerfile already does this for `logra`.
3. **Trim the dependency surface** of the library entry. The middleware should
   only need `jose` (+ `express` types as a peer/`devDependency`). It must not drag
   in the full server stack (`express-openapi-validator`, `swagger-ui-express`,
   `helmet`, `cors`, rate-limit, `logra`, …). If the current single `package.json`
   makes that hard, consider isolating the lib's deps so consumers don't inherit
   the whole service.
4. **Versioning** via a git tag / `semver:` range, same pattern as
   `logra` (`github:GiganticPlayground/logra#semver:^1.0.0`).

**Consume it from Memcard** (the remaining work — the lib is ready):

1. `yarn add github:GiganticPlayground/token-weaver#semver:^1.0.0` — the lib is
   published at **`v1.0.2`** (which already contains the auth middleware, the authz
   layer, the `jwt-*` mode rename, and the env helper). Note Memcard uses **yarn**
   — the `prepare`/`dist` logra-style gotcha may need the same Dockerfile rebuild
   step already used for logra.
2. Rewrite `src/middlewares/auth.middleware.ts` to delegate to the shared lib,
   keeping the `sub`/`app` mapping in `onVerified`:

   ```ts
   import { createAuthMiddleware } from 'token-weaver/auth';

   export const authMiddleware = createAuthMiddleware({
     mode: config.JWT_AUTH_MODE,          // 'jwt-jwks' | 'jwt-hs256'
     issuer: config.JWT_ISSUER,
     ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
     ...(config.JWT_AUTH_MODE === 'jwt-jwks' ? { jwksUri: config.JWKS_URI } : {}),
     ...(config.JWT_AUTH_MODE === 'jwt-hs256' ? { secret: config.JWT_SECRET } : {}),
     onVerified: (payload, req) => {
       const userId = payload.sub;
       const app = payload[config.JWT_APP_CLAIM];
       if (typeof userId !== 'string' || !userId) throw new HttpError(401, '...');
       if (typeof app !== 'string' || !app) throw new HttpError(401, '...');
       req.auth = { userId, app };
     },
   });
   ```

   (Keep Memcard's existing 401 semantics for missing `sub`/`app`. The lib's
   `AuthError` → 401 is already compatible with the error middleware; confirm the
   error handler renders it, or map it.)
3. Env/config from Option A's step 1 drives the mode. **Alternative:**
   `createAuthMiddlewareFromEnv({ prefix: 'AUTH_' })` reads `AUTH_MODE`,
   `AUTH_ISSUER`, `AUTH_JWKS_URI`, `AUTH_SECRET`, … directly — less wiring, but it
   moves the source of truth out of Memcard's Zod config (which is the repo's
   fail-fast convention). **Recommendation: keep Memcard's Zod config + the
   options-object factory** for consistency; treat `FromEnv` as a fallback.

**Trade-offs (A vs B):**

| Aspect            | Option A (inline)            | Option B (shared lib)                              |
| ----------------- | ---------------------------- | -------------------------------------------------- |
| Effort            | Low — one repo               | **Now low** — TW packaging is DONE; only consume it |
| Reuse             | None (copy/paste elsewhere)  | Shared across projects                             |
| Coupling          | None                         | Memcard depends on token-weaver as a lib           |
| Install fragility | None new                     | Inherits the `prepare`/`dist` gotcha               |
| OSS contribution  | —                            | ✅ Already contributed to token-weaver              |
| Extra capability  | —                            | Optional authz layer available for free later      |

> Since the token-weaver lib already exists and is tested, **Option B's main cost
> (packaging) is paid**. Option A is now only worthwhile if we want zero coupling
> to token-weaver.

## Open questions / details to confirm

- Env var names (`JWT_AUTH_MODE`, `JWT_SECRET`) — final naming?
- Should `secret` mode allow a configurable algorithm list (e.g. `HS384`/`HS512`)
  or is `HS256` fixed?
- Is the `static` bearer mode in scope for Memcard, or only `jwks` + `secret`?
- Any need to support **both** modes simultaneously (try one, fall back), or is a
  single active mode per deployment sufficient? (Reference uses a single mode.)
- Test coverage expectations for the new HS256 path.
- **Option A vs B**: now that the lib exists and is tested, default to **B**
  unless we explicitly want zero coupling to token-weaver. Confirm.
- **Dependency from Memcard**: pin via `#semver:^1.0.0` (tags `v1.0.0..v1.0.2`
  exist; `v1.0.2` is current and has everything). Confirm the version policy.
- **Config source of truth**: Memcard's Zod config + options-object factory
  (preferred, matches repo convention) vs the lib's `createAuthMiddlewareFromEnv`.
- Whether to surface the optional authz layer (`requirements`/`paths`) in Memcard
  now or defer (default: defer).
- For B, the logra-style `prepare`/`dist` gotcha under Memcard's **yarn** +
  Dockerfile — likely needs the same explicit rebuild step already used for logra.

## Out of scope

- Issuing tokens (Memcard only verifies).
- Scope/claim authorization and path allow/deny lists from the reference.
- Key rotation tooling for the shared secret.
- Exposing token-weaver's **issuing** endpoints/strategies/config as a library —
  Option B exports **only** the shared auth-verification middleware utility.
