# Handoff

**This is the only handoff document in the repository.** It is updated in place whenever
there is state worth carrying to the next person or session — never copied, never dated
into a second file. If something here is stale, correct it rather than appending.

What belongs here: where the work stands right now, decisions whose reasoning is not
visible in the code, and open items nobody has claimed. What does not: architecture
(`CLAUDE.md`), usage (`README.md`), or anything git history already records.

_Last updated: 2026-07-28_

---

## Where the work stands

**Branch `feat/white-list` → [PR #2](https://github.com/GiganticPlayground/memcard/pull/2)** (open, base `main`).
Five commits, readable in order:

| Commit | What it does |
| --- | --- |
| `35f653b` | Enforces the whitelist/blacklist path claims a token carries (`403` before identity mapping) |
| `010fe68` | Moves the strategy list into a deployment config file; adds the `/v1/memcard/admin/{app}/{userId}/state` routes |
| `be7e0e3` | Normalizes and validates `MEMCARD_KEY_PREFIX` / `MEMCARD_ENV`, the two S3 key segments |
| `2bafd6e` | Adds `${file:PATH}` as a secret source, for mounted Docker/K8s secrets |
| `740f1a8` | Decouples the config loader from the env singleton and renames to Qodi's layout |

`yarn validate` clean, 60 tests passing, working tree clean as of the last commit. The PR
description carries the full narrative — treat it as the review-facing summary and this
file as the working state.

**Black-box verification lives in `tests/verification/`** (its own README). Three PayloadStash
suites against a running stack and the real bucket: 62 assertions on auth, the ETag cycle
and the admin routes, plus narrow suites for 413/429 and for S3 being unreachable. All
green as of 2026-07-28. It found no defect in Memcard; what it did find was a bug in
PayloadStash itself, written up in `tests/verification/BUG-header-capture-case.md` and worked
around by a patched image built from `tests/verification/Dockerfile.payloadstash`.

## Context that is not in the code

**The S3 bucket is shared with `uni-ipb`.** `MEMCARD_KEY_PREFIX` is what separates the two
trees, which is why the normalization in `be7e0e3` exists and why an empty prefix (the
bucket root) fails the boot instead of meaning "no prefix". The prefix-configuration
pattern was adapted from uni-ipb's own write-up; the parts we did not adopt were adopted
deliberately — Memcard is both the reader and the writer of its objects, so the
reader/writer drift that motivates half of that pattern cannot happen here.

**Choosing a non-colliding prefix is a deployment decision, by agreement.** Nothing in the
code knows what else lives in the bucket, and no registry was added. Whoever deploys
verifies it, and scopes the instance's IAM policy to `arn:aws:s3:::<bucket>/<prefix>/*` so
a wrong prefix fails loudly rather than writing into another service's namespace.

**There is no production data yet.** That is the only reason changing the key prefix is
free today. Once there is, a prefix change orphans every save *silently* — a key that does
not resolve reads as a brand-new player (sentinel ETag, empty state), and the next write
persists that empty state at the new location. Copy the old tree first (`aws s3 sync`).

**The config file follows Qodi, not ipb-nexus.** `src/config/memcard-config.ts` mirrors
`qodi/src/config/qodi-config.ts` in schema, compiler, placeholder resolution, naming, and
file layout. Two divergences are intentional and should survive future edits:

- An explicit `MEMCARD_CONFIG_PATH` that does not exist fails the boot. Qodi's loader
  returns `null` and degrades to env-var auth, so a typo there quietly weakens auth.
- The compiled shape is `CompiledAuthStrategy[]`, not raw `AuthStrategyOptions[]`, because
  Memcard has to trace a verified payload back to its strategy (by `iss`) to know which app
  claim to read and whether the admin routes are reachable. Qodi authorizes only; it never
  builds an identity.

## Open items

Nobody is assigned to these. None block the PR.

- **PR #2's title no longer covers its contents** — the S3 key work is not auth. Suggested:
  _"Multi-strategy auth, config file, and S3 key layout"_.
- **Qodi has the placeholder bug we fixed here.** `qodi/src/config/qodi-config.ts:86` does
  not match an env var name containing a hyphen, so `${env:MY-VAR}` survives verbatim into
  the compiled options and becomes the literal expected token. The fix belongs in that repo.
- **IAM policies for the shared bucket are unwritten.** Code-side work is done; scoping each
  service's role to its own prefix is IaC and has no owner yet.
- **No *in-process* controller test harness.** Coverage still sits at the service and
  middleware layers. The admin handlers are no longer only smoke-tested by hand —
  `tests/verification/` verifies them black-box against a running stack and a real bucket — but
  that suite needs Docker and AWS, so it cannot run in CI next to `yarn test`. An in-process
  harness is still its own change.
- **Upstream nicety in token-weaver:** `onVerified` does not report which strategy accepted
  the request, which is why issuers must be unique here. Passing the winning strategy's
  label would remove that constraint; ipb-nexus would benefit equally.
