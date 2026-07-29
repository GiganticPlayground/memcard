import assert from 'node:assert/strict';
import test from 'node:test';

import type { NextFunction, Request, Response } from 'express';
import { SignJWT } from 'jose';

/**
 * Multi-strategy auth — the middleware built from a deployment config file that
 * declares three callers at once: a player JWT, an internal admin JWT, and a
 * static admin token (`tests/fixtures/auth.multi-strategy.yaml`).
 *
 * Env vars are set *before* the middleware (and therefore the config singleton)
 * is imported, so the import below is dynamic. `node --test` isolates each test
 * file in its own process, so this does not affect other suites.
 */
const PLAYER_ISSUER = 'https://players.test';
const INTERNAL_ISSUER = 'https://internal.test';
const PLAYER_SECRET = 'player-secret';
const INTERNAL_SECRET = 'internal-secret';
const STATIC_TOKEN = 'static-token';
const APP = 'my-game';

process.env.NODE_ENV = 'test';
process.env.LOG_TYPE = 'hidden';
process.env.AWS_REGION = 'us-east-1';
process.env.MEMCARD_S3_BUCKET = 'test-bucket';
process.env.MEMCARD_ENV = 'test';
process.env.JWT_ISSUER = PLAYER_ISSUER;
process.env.JWKS_URI = 'https://players.test/.well-known/jwks.json';
process.env.TEST_PLAYER_SECRET = PLAYER_SECRET;
process.env.TEST_INTERNAL_SECRET = INTERNAL_SECRET;
process.env.TEST_STATIC_TOKEN = STATIC_TOKEN;
process.env.MEMCARD_CONFIG_PATH = 'tests/fixtures/auth.multi-strategy.yaml';

const { authMiddleware } = await import('../../src/middlewares/auth.middleware');

function signToken(
  issuer: string,
  secret: string,
  claims: Record<string, unknown>,
  sub?: string,
): Promise<string> {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuer(issuer);
  if (sub !== undefined) {
    builder = builder.setSubject(sub);
  }
  return builder.setExpirationTime('5m').sign(new TextEncoder().encode(secret));
}

const playerToken = (claims: Record<string, unknown>, sub = 'player-001') =>
  signToken(PLAYER_ISSUER, PLAYER_SECRET, claims, sub);

const internalToken = (claims: Record<string, unknown>, sub?: string) =>
  signToken(INTERNAL_ISSUER, INTERNAL_SECRET, claims, sub);

/** Run the middleware against a synthetic request, resolving with the captured outcome. */
function runMiddleware(
  token: string | undefined,
  route: { baseUrl?: string; path?: string } = {},
): Promise<{ err: unknown; req: Request }> {
  return new Promise((resolve) => {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      baseUrl: route.baseUrl ?? '/v1/memcard',
      path: route.path ?? '/me/state',
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = (err?: unknown) => resolve({ err, req });
    void authMiddleware(req, res, next);
  });
}

const PLAYER_ROUTE = { baseUrl: '/v1/memcard', path: '/me/state' };
const ADMIN_ROUTE = { baseUrl: '/v1/memcard', path: '/admin/my-game/player-001/state' };

const statusOf = (err: unknown) => (err as { status?: number } | undefined)?.status;

test('accepts a token from the first strategy and maps its identity', async () => {
  const token = await playerToken({ app: APP });
  const { err, req } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'player-001', app: APP });
  assert.equal(req.authStrategy?.issuer, PLAYER_ISSUER);
  assert.equal(req.authStrategy?.admin, false);
});

test('falls through to a later strategy and uses its own app claim', async () => {
  // The internal strategy names `tenant` rather than `app`; a token carrying the
  // player-strategy claim would not resolve an identity here.
  const token = await internalToken({ tenant: 'ops' }, 'reporting-service');
  const { err, req } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'reporting-service', app: 'ops' });
  assert.equal(req.authStrategy?.issuer, INTERNAL_ISSUER);
});

test('accepts the static token on an admin route without an identity', async () => {
  const { err, req } = await runMiddleware(STATIC_TOKEN, ADMIN_ROUTE);

  assert.equal(err, undefined);
  assert.equal(req.auth, undefined);
  assert.deepEqual(req.authStrategy, { type: 'static', admin: true });
});

test('rejects the static token on a player route (403)', async () => {
  const { err, req } = await runMiddleware(STATIC_TOKEN, PLAYER_ROUTE);

  assert.equal(statusOf(err), 403);
  assert.equal(req.auth, undefined);
});

test('rejects a non-admin player token on an admin route (403)', async () => {
  const token = await playerToken({ app: APP });
  const { err, req } = await runMiddleware(token, ADMIN_ROUTE);

  assert.equal(statusOf(err), 403);
  assert.equal(req.auth, undefined);
});

test('accepts an admin JWT on an admin route', async () => {
  const token = await internalToken({ tenant: 'ops' }, 'reporting-service');
  const { err, req } = await runMiddleware(token, ADMIN_ROUTE);

  assert.equal(err, undefined);
  assert.equal(req.authStrategy?.admin, true);
});

test('accepts an admin JWT on an admin route even without identity claims', async () => {
  // The target comes from the URL there, so a service token needs no sub/app.
  const token = await internalToken({});
  const { err, req } = await runMiddleware(token, ADMIN_ROUTE);

  assert.equal(err, undefined);
  assert.equal(req.auth, undefined);
  assert.equal(req.authStrategy?.admin, true);
});

test('still requires identity claims on a player route', async () => {
  const token = await internalToken({}, 'reporting-service');
  const { err } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(statusOf(err), 401);
});

test('rejects a token that no strategy verifies (401)', async () => {
  const token = await signToken(PLAYER_ISSUER, 'not-the-secret', { app: APP }, 'attacker');
  const { err } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(statusOf(err), 401);
});

test('rejects a missing Authorization header (401)', async () => {
  const { err } = await runMiddleware(undefined, PLAYER_ROUTE);

  assert.equal(statusOf(err), 401);
});

test('prefers the 403 from a matching strategy over the 401 from the others', async () => {
  // Verified by the player strategy, denied by its own blacklist claim. The other
  // strategies reject it outright, but the informative failure is the 403.
  const token = await playerToken({ app: APP, blacklist: ['/v1/memcard/*'] });
  const { err } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(statusOf(err), 403);
});

test('still enforces the whitelist claim carried by the token', async () => {
  const token = await playerToken({ app: APP, whitelist: ['/somewhere/else'] });
  const { err } = await runMiddleware(token, PLAYER_ROUTE);

  assert.equal(statusOf(err), 403);
});
