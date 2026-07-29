#!/usr/bin/env node
/**
 * Mints every credential the verification suite needs.
 *
 * PayloadStash cannot sign a JWT, and Memcard's three strategies need three
 * different kinds of credential, so this runs before the suite and drops them all
 * into a secrets file that the suite reads with `{ $secrets: KEY }`.
 *
 * Two stages, because they happen either side of `docker compose up`:
 *
 *   secrets  — the HS256 signing secret and the static token. Both have to exist
 *              BEFORE Memcard boots: it reads the secret from a mounted file and
 *              the static token from its environment, once, at startup. Idempotent
 *              on purpose — re-running against a live stack must not invalidate
 *              the credentials that stack already loaded.
 *
 *   tokens   — the JWTs themselves, plus the player token fetched from Token
 *              Weaver. Runs after the stack is healthy, since the JWKS strategy is
 *              the one credential we cannot mint ourselves (RS256 is asymmetric —
 *              only the issuer holds the private key).
 *
 * Everything lands in .run/, which is git-ignored.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SignJWT } from 'jose';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(HERE, '.run');
const HS256_SECRET_FILE = join(RUN_DIR, 'hs256.secret');
const STATIC_TOKEN_FILE = join(RUN_DIR, 'static.token');
const STACK_ENV_FILE = join(RUN_DIR, 'stack.env');
const SUITE_SECRETS_FILE = join(RUN_DIR, 'verify-secrets.env');
const VERIFY_USER_FILE = join(RUN_DIR, 'verify-user.txt');

// Must match memcard-auth.yaml. The issuer is what routes a verified payload back
// to its strategy, so a mismatch here reads as "unknown issuer", not "bad claim".
const HS256_ISSUER = 'memcard-internal';
const HS256_AUDIENCE = 'memcard';
const APP = 'my-game';

const TOKEN_WEAVER_URL = process.env.TOKEN_WEAVER_URL ?? 'http://localhost:3000';
const PLAYER_SECRET = process.env.PLAYER_SECRET ?? 'dev-secret';

/** Read a file the previous stage wrote, with a message that says how to fix it. */
function readGenerated(path, what) {
  if (!existsSync(path)) {
    throw new Error(`${what} not found at ${path} — run "mint-tokens.mjs secrets" first`);
  }
  const value = readFileSync(path, 'utf8').trim();
  if (!value) throw new Error(`${what} at ${path} is empty`);
  return value;
}

function writeEnvFile(path, entries) {
  const body = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  writeFileSync(path, `${body}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Stage: secrets
// ---------------------------------------------------------------------------

function stageSecrets() {
  mkdirSync(RUN_DIR, { recursive: true });

  // Reuse rather than regenerate. Memcard read these at boot; replacing them now
  // would leave the running stack verifying against credentials nobody holds.
  let created = 0;
  if (!existsSync(HS256_SECRET_FILE)) {
    // No trailing newline needed — Memcard's ${file:...} trims, precisely so a
    // mounted secret written with `echo` still compares byte for byte.
    writeFileSync(HS256_SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
    created += 1;
  }
  if (!existsSync(STATIC_TOKEN_FILE)) {
    writeFileSync(STATIC_TOKEN_FILE, `mcv-static-${randomBytes(24).toString('hex')}`, {
      mode: 0o600,
    });
    created += 1;
  }

  // Sourced by the runner so compose can interpolate ${MEMCARD_STATIC_TOKEN}.
  writeEnvFile(STACK_ENV_FILE, {
    MEMCARD_STATIC_TOKEN: readGenerated(STATIC_TOKEN_FILE, 'static token'),
  });

  console.log(
    created === 0
      ? 'secrets: reusing existing .run/hs256.secret and .run/static.token'
      : `secrets: generated ${created} new credential(s) in .run/`,
  );
}

// ---------------------------------------------------------------------------
// Stage: tokens
// ---------------------------------------------------------------------------

/**
 * Sign one HS256 token.
 *
 * `claims` are merged in as-is so a case can add, omit, or corrupt anything the
 * strategy checks — that freedom is the whole reason these are minted here rather
 * than requested from Token Weaver.
 */
async function mintHs256({
  secret,
  subject,
  claims = {},
  expiresIn = 3600,
  issuer = HS256_ISSUER,
  audience = HS256_AUDIENCE,
  omitApp = false,
}) {
  const now = Math.floor(Date.now() / 1000);
  const jwt = new SignJWT(omitApp ? { ...claims } : { app: APP, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setIssuer(issuer)
    .setAudience(audience)
    .setExpirationTime(now + expiresIn);
  // Omitted entirely rather than set empty: `sub` absent is what the middleware
  // checks for, and an empty string would take a different branch.
  if (subject !== null) jwt.setSubject(subject);
  return jwt.sign(new TextEncoder().encode(secret));
}

/**
 * The one kind of credential we cannot produce ourselves: RS256, signed by Token
 * Weaver. `strategy` names the endpoint, which is how the dev config exposes
 * different claim sets — see dev/token-weaver/token-weaver.yaml.
 */
async function fetchPlayerToken(strategy = 'game-client', secret = PLAYER_SECRET) {
  const url = `${TOKEN_WEAVER_URL}/auth/${strategy}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
  } catch (error) {
    throw new Error(`Token Weaver unreachable at ${url}: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Token Weaver returned ${response.status} for ${url}`);
  }

  const body = await response.json();
  if (typeof body.token !== 'string' || !body.token) {
    throw new Error(`Token Weaver response from ${url} carried no token`);
  }
  return body.token;
}

async function stageTokens() {
  const secret = readGenerated(HS256_SECRET_FILE, 'HS256 secret');
  const staticToken = readGenerated(STATIC_TOKEN_FILE, 'static token');

  // A valid signature over the wrong secret — proves rejection is the signature
  // check and not something incidental about the payload.
  const wrongSecret = randomBytes(32).toString('hex');

  const fullClaims = { scope: 'memcard:admin', roles: ['memcard-operator'] };

  const [
    playerToken,
    playerBlacklisted,
    playerWhitelisted,
    hs256Admin,
    hs256NoScope,
    hs256NoRole,
    hs256Blacklisted,
    hs256Whitelisted,
    hs256BadSignature,
    hs256Expired,
    hs256WrongAudience,
    hs256UnknownIssuer,
    hs256NoApp,
    hs256NoSub,
  ] = await Promise.all([
    fetchPlayerToken(),
    // RS256 players whose own claims carry path rules — the only way to exercise
    // whitelistClaim/blacklistClaim on the jwks strategy, since the default dev
    // players deliberately carry neither.
    fetchPlayerToken('path-claims-player', 'secret-blacklisted'),
    fetchPlayerToken('path-claims-player', 'secret-whitelisted'),
    mintHs256({ secret, subject: 'svc-admin', claims: fullClaims }),
    // Drops `scope` only: isolates the `scope` requirement from the other one.
    mintHs256({ secret, subject: 'svc-no-scope', claims: { roles: ['memcard-operator'] } }),
    // Drops `roles` only: isolates `claim_includes`.
    mintHs256({ secret, subject: 'svc-no-role', claims: { scope: 'memcard:admin' } }),
    // Fully authorized, but its own claim denies the admin routes — the token's
    // rules narrow what the strategy would otherwise allow.
    mintHs256({
      secret,
      subject: 'svc-blacklisted',
      claims: { ...fullClaims, blacklist: ['/v1/memcard/admin/*'] },
    }),
    // Allow-list that names only the player routes, so admin falls outside it.
    mintHs256({
      secret,
      subject: 'svc-whitelisted',
      claims: { ...fullClaims, whitelist: ['/v1/memcard/me/*'] },
    }),
    mintHs256({ secret: wrongSecret, subject: 'svc-forged', claims: fullClaims }),
    mintHs256({ secret, subject: 'svc-expired', claims: fullClaims, expiresIn: -60 }),
    // Correctly signed, wrong `aud`. The strategy declares audience: memcard, so
    // this must not verify — a token minted for another service is not ours.
    mintHs256({
      secret,
      subject: 'svc-wrong-aud',
      claims: fullClaims,
      audience: 'some-other-service',
    }),
    // Correctly signed, issuer nobody declared. Nothing can trace it back to a
    // strategy, so it cannot verify.
    mintHs256({
      secret,
      subject: 'svc-unknown-iss',
      claims: fullClaims,
      issuer: 'https://not-configured.example.com',
    }),
    // Valid everywhere except that it names no app, so it cannot resolve to an S3
    // key on the player routes. Fine on the admin routes, where the URL names the
    // target — which is why the suite sends it at /me/ specifically.
    mintHs256({ secret, subject: 'svc-no-app', claims: fullClaims, omitApp: true }),
    // Same idea for the other half of the identity: no `sub`, so no player.
    mintHs256({ secret, subject: null, claims: fullClaims }),
  ]);

  // A player id nobody has used before, minted here rather than in the shell so
  // the runner needs no randomness of its own. The sentinel-ETag and create-only
  // assertions only mean anything against a player that has never existed, so
  // this must be fresh on every run — unlike the credentials above, which are
  // deliberately reused.
  const verifyUser = `mcv-${randomBytes(6).toString('hex')}`;
  writeFileSync(VERIFY_USER_FILE, verifyUser);

  // Each value is a COMPLETE Authorization header, scheme included — hence the
  // `_AUTH` names rather than `_TOKEN`.
  //
  // The scheme lives here instead of in the suite YAML for one reason: secret
  // scanners flag `Authorization: "Bearer <anything>"` on sight, and the suites
  // were tripping GitGuardian on lines that contain no secret at all, only the
  // NAME of one. Moving the word `Bearer` out of the YAML removes the pattern
  // the scanner matches on. Nothing about how the credentials work changes.
  //
  // The cost is real and worth stating: the suite no longer says anywhere which
  // auth scheme it speaks. That is what this comment is for.
  const credentials = Object.fromEntries(
    Object.entries({
      PLAYER_AUTH: playerToken,
      PLAYER_BLACKLIST_AUTH: playerBlacklisted,
      PLAYER_WHITELIST_AUTH: playerWhitelisted,
      STATIC_AUTH: staticToken,
      HS256_ADMIN_AUTH: hs256Admin,
      HS256_NOSCOPE_AUTH: hs256NoScope,
      HS256_NOROLE_AUTH: hs256NoRole,
      HS256_BLACKLIST_AUTH: hs256Blacklisted,
      HS256_WHITELIST_AUTH: hs256Whitelisted,
      HS256_BADSIG_AUTH: hs256BadSignature,
      HS256_EXPIRED_AUTH: hs256Expired,
      HS256_WRONGAUD_AUTH: hs256WrongAudience,
      HS256_UNKNOWNISS_AUTH: hs256UnknownIssuer,
      HS256_NOAPP_AUTH: hs256NoApp,
      HS256_NOSUB_AUTH: hs256NoSub,
    }).map(([name, value]) => [name, `Bearer ${value}`]),
  );
  writeEnvFile(SUITE_SECRETS_FILE, credentials);

  console.log(
    `tokens: wrote ${Object.keys(credentials).length} credentials to .run/verify-secrets.env`,
  );
  console.log(`tokens: throwaway player is my-game/${verifyUser}`);
}

// ---------------------------------------------------------------------------

const stage = process.argv[2];
try {
  if (stage === 'secrets') {
    stageSecrets();
  } else if (stage === 'tokens') {
    await stageTokens();
  } else {
    console.error(`Usage: mint-tokens.mjs <secrets|tokens>`);
    process.exit(2);
  }
} catch (error) {
  console.error(`mint-tokens: ${error.message}`);
  process.exit(1);
}
