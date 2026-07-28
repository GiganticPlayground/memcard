# Memcard — PayloadStash verification suite

Black-box verification of a running Memcard against a real S3 bucket, using
[PayloadStash](https://github.com/ericwastaken/PayloadStash) with one upstream bug
patched (see [The patched image](#the-patched-image)). No Node or Python on the
host beyond what this repo already has; everything runs in containers.

It exists to cover what the unit tests cannot: the wiring. `yarn test` exercises
`S3StateStore`, `MemcardService` and the auth compiler in isolation, but nothing
asserts that a real request with a real token produces a real conditional write
against a real bucket. That gap is where the admin routes and the multi-strategy
auth live.

```bash
yarn dev:keys                          # once — generates the RSA key Token Weaver signs with
./x-run-memcard-stash.sh               # full suite (38 requests, 62 assertions)
./x-run-memcard-stash.sh limits        # 413 + 429, on a stack configured to refuse
./x-run-memcard-stash.sh unavailable   # 503, on a stack whose S3 client is pointed at a dead port
```

The two narrow suites leave the stack in the state they needed. Re-run the full
suite to restore it.

Artifacts land in `output/<label>-<timestamp>/`: `report.md` (the assertion
verdicts — read this one), `results.csv`, `run.log`, the resolved config, and the
raw response body per request. Exit code is `0` when every assertion passed, `1`
when one failed, `9` on a config error.

## What it covers

38 requests over seven sequences, plus two narrow suites.

| Sequence | Asserts |
|---|---|
| `health` | The service is up and identifies itself as `memcard` |
| `authn` | Fifteen ways a credential is refused, and the `401` vs `403` distinction between them: no token, forged signature, expiry, wrong audience, unknown issuer, missing `sub`, missing `app`, the admin gate, both `requirements`, claim-based path rules, and the static token's inline whitelist |
| `player_state` | The ETag cycle on `/v1/memcard/me/state`: read → conditional write → stale write is `409` → `If-None-Match` is `304` → a stale validator is not |
| `admin_state` | The same cycle on `/v1/memcard/admin/{app}/{userId}/state` against a player that has never existed — the only place the sentinel ETag and the create-only write can be asserted — plus the same object reached by a second admin strategy |
| `path_claims` | That a token whose claim denies one route still reaches the routes it allows, on both the `jwks` and `hs256` strategies |
| `key_segments` | Segments the spec must reject — an illegal character, `.` and `..` (percent-encoded so no client normalizes them away), on both read and write |
| `malformed_requests` | Writes the spec refuses before anything looks at them: no `If-Match`, an unknown property, no `state` |
| `limits` *(suite)* | `413` over the body cap, `429` over the rate limit |
| `unavailable` *(suite)* | `503` with a message on read and write when S3 is unreachable, while `/health` stays `200` |

**All three auth strategy types are live at once**, which is the point of
`config/memcard-auth.yaml`:

- **`jwks`** — the mobile players. RS256, verified against Token Weaver's JWKS.
  The one credential the runner cannot mint itself: RS256 is asymmetric, so only
  the issuer holds the signing key.
- **`hs256`** — an internal service. Symmetric, so the runner signs these tokens
  directly and never asks Token Weaver for them. That is deliberate: this
  strategy stays green even if Token Weaver is down.
- **`static`** — a shared bearer string, no JWT at all. No claims, so it cannot
  name a player, which is why the compiler forces `admin: true` on it.

And every way a value can be sourced, so one boot proves the whole surface:

| Source | Used for |
|---|---|
| `${env:VAR}` | the JWKS issuer and URL, and the static token |
| `${file:PATH}` | the HS256 secret, mounted the way a Docker/K8s secret actually arrives |
| literal | the HS256 issuer |

Plus `audience`, `appClaim`, both `requirements` kinds (`scope` and
`claim_includes`, asserted separately so a failure names which one broke),
claim-based `whitelistClaim`/`blacklistClaim`, and an inline `whitelist`.

**The custom key prefix** is set to `custom-memcard` by the compose overlay. The
suite itself cannot see S3 — it only speaks HTTP — so the runner lists the bucket
under that prefix after the run. That listing is the only direct evidence the
value was honored.

## How a run is put together

The order matters, and it is why this is a script rather than a single
`docker run`:

1. **Generate the credentials Memcard reads at boot** — the HS256 secret (written
   to `.run/hs256.secret`, mounted into the container) and the static token
   (exported so compose can interpolate it). Both are read once, at startup, so
   they must exist first. This step is idempotent: re-running against a live
   stack reuses them rather than invalidating what that stack already loaded.
2. **Bring the stack up** — `docker-compose.dev.yml` plus
   `docker-compose.verify.yml`, layered so the plain dev stack keeps working
   unchanged.
3. **Mint the tokens the suite presents** — including the player token, fetched
   from Token Weaver now that it is running.
4. **Render the suite** — PayloadStash's `URLPath` is a literal string with no
   interpolation, so the throwaway player id gets in by substituting
   `__VERIFY_USER__`. A fresh id per run is what makes the sentinel-ETag and
   create-only assertions meaningful.
5. **Run it, then list S3** and delete the throwaway player's object
   (`KEEP_STATE=1` keeps it).

## The patched image

The runner builds `memcard/payloadstash:patched` from `Dockerfile.payloadstash`,
a single-layer patch over the upstream image. Upstream 1.0.2 resolves
`headers.<name>` like this:

```python
return headers.get(path[len("headers."):].lower())
```

It lowercases the name you asked for but never normalizes the response header
dict, which is keyed with whatever casing the server sent. So `headers.<name>`
returns `None` unless the server emits that header in all-lowercase — and the
formal spec's rule that "`<name>` must be lowercase" is precisely what makes it
fail.

Memcard sends `ETag`, and Memcard's whole concurrency model rides on that header,
so unpatched **every ETag capture and assertion silently resolved to `None`** —
including `notEquals '0'`, which *passes* against `None`. The first green-looking
run was testing nothing. That is the failure mode worth remembering: a capture
that quietly yields nothing turns downstream assertions into noise, and only the
ones written as `exists: true` catch it.

The alternative was to make Memcard emit a lowercase `etag`. Header names are
case-insensitive per RFC 9110 so it would have worked, but bending a service's
public surface around a private tool's defect is the wrong trade. Once this is
fixed upstream, delete the Dockerfile and set `PS_IMAGE` back to
`ghcr.io/ericwastaken/payloadstash:main`.

## Layout

| Path | What it is |
|---|---|
| `x-run-memcard-stash.sh` | The runner. Start here. |
| `Dockerfile.payloadstash` | The patched PayloadStash image — see above |
| `BUG-header-capture-case.md` | The upstream bug report, ready to file |
| `mint-tokens.mjs` | Mints every credential; two stages, either side of `compose up` |
| `config/` | Config consumed by the stack, not by PayloadStash — kept apart from `suites/` because it is a different kind of artifact |
| `config/memcard-auth.yaml` | Memcard's own auth config for the run — all three strategies |
| `suites/` | **The PayloadStash suites** — one config per file, the thing to read or extend when adding coverage |
| `suites/memcard-verify.yml.tpl` | The functional suite (template; `__VERIFY_USER__` is substituted per run) |
| `suites/memcard-limits.yml` | The 413/429 suite |
| `suites/memcard-unavailable.yml` | The 503 suite |
| `docker-compose.verify.yml` | Overlay: custom prefix, config file, mounted secret |
| `docker-compose.limits.yml` | Overlay: small body cap, low rate limit |
| `docker-compose.unavailable.yml` | Overlay: S3 client pointed at a dead port |
| `.run/` | Everything generated. Git-ignored, regenerated per run. |
| `output/` | Run artifacts. Git-ignored. |

## What it does not cover

- **The S3 key layout.** PayloadStash only speaks HTTP; it cannot assert an
  object landed at `${prefix}/${env}/${app}/${userId}/state.json`. The runner's
  listing shows the tree, but no assertion fails if the layout is wrong.
- **`pathPrefix`** on a strategy's `paths` block. It strips a mount prefix before
  matching, which this deployment does not use.
- **The `delegated` Token Weaver strategy type** and JWKS key rotation.
- **Concurrent writers.** Every conflict here is manufactured by replaying a
  stale ETag, not by two clients racing.
- **The stored envelope.** `schemaVersion` and `lastModifiedAt` are only checked
  indirectly, by the `state` round-trip; nothing reads the object in S3.
- **Peripheral surface** — helmet headers, CORS, `/api-docs`, graceful shutdown.

## Notes

- The player on the `/me/` routes is fixed by the token's `sub` (`player-001`),
  so that sequence runs against state left by previous runs. Every assertion
  there is written to hold whatever the starting state is — none of them pin a
  specific ETag value, only the relationships between them. The admin sequence is
  where a clean slate is available, and that is where the absolute assertions live.
- The `limits` suite's three requests are one sequence and the count is exact.
  The middleware order is **body parser → rate limiter → auth**, so the
  oversized-body request is rejected by the parser and never reaches the limiter —
  it costs nothing against the budget. With `RATE_LIMIT_MAX=1` that leaves request
  2 inside the window and request 3 over it. Reordering or adding a request breaks
  the arithmetic.
- Running `limits` leaves the stack with a 4 KiB body cap and a 1-request rate
  limit; `unavailable` leaves its S3 client pointed at a dead port. Re-run
  `verify` to restore it, or tear it down.
- The runner **restarts both services on every run**, unconditionally. Their
  config files are mounted, not baked into the image, and both are read once at
  startup — so compose sees nothing to recreate when one changes and would
  happily leave the old process serving the old config. A suite that passes
  against a configuration nobody is looking at is worse than one that fails.
- `dev/token-weaver/token-weaver.yaml` gained a `path-claims-player` strategy for
  this suite: two players whose tokens carry `whitelist`/`blacklist` claims. It is
  purely additive — the five `game-client` players are untouched, and their
  *absence* of those claims is what exercises the unrestricted case.
