#!/usr/bin/env bash
#
# x-run-memcard-stash.sh — run a PayloadStash suite against a local Memcard stack
# configured with all three auth strategy types and a custom S3 key prefix.
#
# Usage:
#   ./x-run-memcard-stash.sh [verify|limits|unavailable] [label]
#
#   verify (default) : the full verification suite
#   limits           : 413 + 429 only, on a stack deliberately configured to refuse
#   unavailable      : 503 only, on a stack whose S3 client points at a dead port
#   label            : tag for the output folder (default: the suite name)
#
# The suites themselves live in ./suites/ — one PayloadStash config per file.
#
# Env overrides:
#   PS_IMAGE         : PayloadStash image (default ghcr.io/ericwastaken/payloadstash:main)
#   MEMCARD_URL      : Memcard base URL as seen from the HOST (default http://127.0.0.1:3010)
#   TOKEN_WEAVER_URL : Token Weaver base URL as seen from the HOST (default http://localhost:3000)
#   KEEP_STATE       : set to 1 to keep the throwaway admin player's S3 object
#
# What it does, in order: generate the credentials Memcard reads at boot, bring the
# stack up with them, mint the tokens the suite presents, render the suite with a
# throwaway player id, run it, then show what actually landed in S3.
#
# Artifacts: ./output/<label>-<timestamp>/ (report.md, results.csv, run.log,
# resolved config, raw responses).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$DIR/../.." && pwd)"
RUN_DIR="$DIR/.run"

SUITE="${1:-verify}"
LABEL="${2:-$SUITE}"

# Locally patched PayloadStash. Upstream 1.0.2 cannot read a response header whose
# name the server did not send in lowercase, which for Memcard means ETag — see
# Dockerfile.payloadstash. Set PS_IMAGE to override once that is fixed upstream.
IMAGE="${PS_IMAGE:-memcard/payloadstash:patched}"
MEMCARD_URL="${MEMCARD_URL:-http://127.0.0.1:3010}"
TOKEN_WEAVER_URL="${TOKEN_WEAVER_URL:-http://localhost:3000}"

case "$SUITE" in
  verify | limits | unavailable) ;;
  *)
    echo "Unknown suite '$SUITE' — expected 'verify', 'limits' or 'unavailable'" >&2
    exit 2
    ;;
esac

for tool in docker node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required" >&2; exit 1; }
done

# Token Weaver signs the player tokens with this key. It is git-ignored and
# generated once — without it the stack comes up but issues nothing.
if [ ! -f "$REPO/dev/token-weaver/keys/private-key.pem" ]; then
  echo "Missing dev/token-weaver/keys/private-key.pem — run 'yarn dev:keys' first" >&2
  exit 1
fi

mkdir -p "$RUN_DIR" "$DIR/output"

# ---------------------------------------------------------------------------
# 0. The patched PayloadStash image. Built once and cached; rebuilt silently when
#    the Dockerfile changes. Only when PS_IMAGE still points at our own tag — an
#    explicit override is taken at face value.
# ---------------------------------------------------------------------------
if [ "$IMAGE" = "memcard/payloadstash:patched" ]; then
  echo "==> Building patched PayloadStash image"
  docker build --platform linux/amd64 \
    -t "$IMAGE" -f "$DIR/Dockerfile.payloadstash" "$DIR" >/dev/null
fi

# ---------------------------------------------------------------------------
# 1. Credentials Memcard itself reads, which must exist before it boots: the
#    HS256 secret it mounts as a file and the static token it takes from its
#    environment. Idempotent — a re-run against a live stack reuses them.
# ---------------------------------------------------------------------------
echo "==> Generating stack credentials"
node "$DIR/mint-tokens.mjs" secrets

# shellcheck source=/dev/null
set -a; . "$RUN_DIR/stack.env"; set +a

# ---------------------------------------------------------------------------
# 2. Bring the stack up. Compose runs from the repo root so that the overlay's
#    ./tests/verification/... paths resolve, and so the base dev stack is the one
#    being layered on rather than replaced.
# ---------------------------------------------------------------------------
COMPOSE_FILES=(-f docker-compose.dev.yml -f tests/verification/docker-compose.verify.yml)
case "$SUITE" in
  limits) COMPOSE_FILES+=(-f tests/verification/docker-compose.limits.yml) ;;
  unavailable) COMPOSE_FILES+=(-f tests/verification/docker-compose.unavailable.yml) ;;
esac

echo "==> Starting stack (suite: $SUITE)"
(cd "$REPO" && docker compose "${COMPOSE_FILES[@]}" up -d --build)

# Both services read their config file ONCE at startup, and both files are
# mounted rather than baked into the image — so compose sees nothing to recreate
# when one changes and leaves the old process running with the old config. The
# suite would then pass or fail against a configuration nobody is looking at.
# Restarting unconditionally costs a few seconds and removes the whole class of
# problem; `up -d` above has already applied any change that does need a recreate.
echo "==> Restarting services to pick up mounted config"
(cd "$REPO" && docker compose "${COMPOSE_FILES[@]}" restart token-weaver memcard >/dev/null)

echo "==> Waiting for services"
wait_for() {
  local name="$1" url="$2" tries=60
  until curl -fsS "$url" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      echo "    $name did not become healthy at $url" >&2
      echo "    Logs: docker compose ${COMPOSE_FILES[*]} logs $3" >&2
      exit 1
    fi
    sleep 2
  done
  echo "    $name is up"
}
wait_for "Token Weaver" "$TOKEN_WEAVER_URL/health" token-weaver
wait_for "Memcard" "$MEMCARD_URL/health" memcard

# ---------------------------------------------------------------------------
# 3. Tokens the SUITE presents. Minted after the stack is up because the player
#    token has to come from Token Weaver — RS256 is asymmetric, so it is the one
#    credential we cannot produce ourselves.
# ---------------------------------------------------------------------------
echo "==> Minting suite tokens"
TOKEN_WEAVER_URL="$TOKEN_WEAVER_URL" node "$DIR/mint-tokens.mjs" tokens

# ---------------------------------------------------------------------------
# 4. Render the suite. PayloadStash's URLPath is a literal with no interpolation,
#    so the throwaway player id can only get in by substitution. A fresh id per
#    run is what makes the sentinel-ETag and create-only assertions meaningful:
#    they only hold for a player that has never existed.
# ---------------------------------------------------------------------------
if [ "$SUITE" = "verify" ]; then
  VERIFY_USER="$(cat "$RUN_DIR/verify-user.txt")"
  echo "==> Throwaway admin player: my-game/$VERIFY_USER"
  sed "s/__VERIFY_USER__/$VERIFY_USER/g" \
    "$DIR/suites/memcard-verify.yml.tpl" > "$RUN_DIR/memcard-verify.yml"
  SUITE_FILE="memcard-verify.yml"
else
  # The other suites address only the token's own player, so they need no
  # substitution and leave nothing behind to clean up.
  VERIFY_USER=""
  SUITE_FILE="memcard-$SUITE.yml"
  cp "$DIR/suites/$SUITE_FILE" "$RUN_DIR/$SUITE_FILE"
fi

# ---------------------------------------------------------------------------
# 5. Run it.
# ---------------------------------------------------------------------------
OUT="$DIR/output/${LABEL}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

echo "==> Running PayloadStash → $OUT"
echo "    image : $IMAGE"
echo "    suite : $SUITE_FILE"

# .run holds both the rendered suite and the secrets file, so one mount covers
# both. --add-host makes host.docker.internal resolve on plain Linux too; the
# suite's URLRoot uses it to reach Memcard's published port.
STATUS=0
docker run --rm -i \
  --platform linux/amd64 \
  --add-host host.docker.internal:host-gateway \
  -v "$RUN_DIR":/app/config:ro \
  -v "$OUT":/app/output \
  "$IMAGE" \
  run "/app/config/$SUITE_FILE" \
  --secrets /app/config/verify-secrets.env \
  --out /app/output --yes || STATUS=$?

# ---------------------------------------------------------------------------
# 6. What actually landed in S3. The suite cannot see this — it only speaks HTTP —
#    and it is the only direct evidence that MEMCARD_KEY_PREFIX was honored.
# ---------------------------------------------------------------------------
if command -v aws >/dev/null 2>&1 && [ -f "$REPO/.env" ]; then
  # shellcheck source=/dev/null
  set -a; . "$REPO/.env"; set +a
  if [ -n "${MEMCARD_S3_BUCKET:-}" ]; then
    echo ""
    echo "==> S3 tree under the configured prefix"
    echo "    s3://$MEMCARD_S3_BUCKET/custom-memcard/"
    aws s3 ls "s3://$MEMCARD_S3_BUCKET/custom-memcard/" --recursive 2>&1 | sed 's/^/    /' || true

    if [ -n "$VERIFY_USER" ] && [ "${KEEP_STATE:-0}" != "1" ]; then
      KEY="custom-memcard/${MEMCARD_ENV:-dev}/my-game/$VERIFY_USER/state.json"
      echo "==> Removing throwaway player object ($KEY)"
      aws s3 rm "s3://$MEMCARD_S3_BUCKET/$KEY" >/dev/null 2>&1 \
        && echo "    removed" \
        || echo "    not removed (already gone, or no permission)"
    fi
  fi
else
  echo ""
  echo "==> Skipping S3 listing (aws CLI or .env not available)"
fi

echo ""
if [ "$STATUS" -eq 0 ]; then
  echo "Suite '$SUITE' PASSED. Report: $OUT/report.md"
else
  echo "Suite '$SUITE' FAILED (exit $STATUS). Report: $OUT/report.md"
fi

if [ "$SUITE" != "verify" ]; then
  echo ""
  case "$SUITE" in
    limits)
      echo "NOTE: the stack is still running with a 4 KiB body cap and a 1-request"
      echo "      rate limit."
      ;;
    unavailable)
      echo "NOTE: the stack is still running with its S3 client pointed at a dead"
      echo "      port. Every state request will fail until it is restored."
      ;;
  esac
  echo "      Re-run './x-run-memcard-stash.sh verify' to restore it, or tear it"
  echo "      down: docker compose ${COMPOSE_FILES[*]} down"
fi

exit "$STATUS"
