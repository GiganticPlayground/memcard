import assert from 'node:assert/strict';
import test from 'node:test';

import type { NextFunction, Request, Response } from 'express';
import { SignJWT } from 'jose';

/**
 * Auth middleware test — exercises the HS256 (`jwt-hs256`) verification path
 * end to end against the shared `token-weaver/auth` middleware.
 *
 * This covers the **env-derived** single strategy, i.e. the setup with no auth
 * config file, so it assumes `config/memcard.yaml` does not exist in the working
 * tree (nothing commits one; the example lives at `examples/memcard.yaml`).
 * Multi-strategy behavior is covered in `auth.multi-strategy.test.ts`.
 *
 * Env vars are set *before* the middleware (and therefore the config singleton)
 * is imported, so we use a dynamic import below. `node --test` isolates each
 * test file in its own process, so this does not affect other suites.
 */
const SECRET = 'unit-test-secret';
const ISSUER = 'https://auth.test';
const APP = 'my-game';
const APP_CLAIM = process.env.JWT_APP_CLAIM ?? 'app';

process.env.NODE_ENV = 'test';
process.env.LOG_TYPE = 'hidden';
process.env.AWS_REGION = 'us-east-1';
process.env.MEMCARD_S3_BUCKET = 'test-bucket';
process.env.MEMCARD_ENV = 'test';
process.env.JWT_ISSUER = ISSUER;
process.env.JWT_AUTH_MODE = 'jwt-hs256';
process.env.JWT_SECRET = SECRET;

const { authMiddleware } = await import('../../src/middlewares/auth.middleware');

const key = new TextEncoder().encode(SECRET);

function signToken(claims: Record<string, unknown>, sub?: string): Promise<string> {
  let builder = new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setIssuer(ISSUER);
  if (sub !== undefined) {
    builder = builder.setSubject(sub);
  }
  return builder.setExpirationTime('5m').sign(key);
}

/** Run the middleware against a synthetic request, resolving with the captured outcome. */
function runMiddleware(
  token: string | undefined,
  route: { baseUrl?: string; path?: string } = {},
): Promise<{ err: unknown; req: Request }> {
  return new Promise((resolve) => {
    const req = {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      baseUrl: route.baseUrl ?? '',
      path: route.path ?? '/',
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = (err?: unknown) => resolve({ err, req });
    void authMiddleware(req, res, next);
  });
}

// Path matched by the auth middleware is `req.baseUrl + req.path`.
const MEMCARD_ROUTE = { baseUrl: '/v1/memcard', path: '/player-001/state' };

test('accepts a valid HS256 token and maps sub/app onto req.auth', async () => {
  const token = await signToken({ [APP_CLAIM]: APP }, 'player-001');
  const { err, req } = await runMiddleware(token);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'player-001', app: APP });
});

test('rejects a token signed with a different secret (401)', async () => {
  const token = await new SignJWT({ app: APP })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setSubject('attacker')
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode('wrong-secret'));

  const { err } = await runMiddleware(token);
  assert.equal((err as { status?: number }).status, 401);
});

test('rejects a missing Authorization header (401)', async () => {
  const { err } = await runMiddleware(undefined);
  assert.equal((err as { status?: number }).status, 401);
});

test('rejects a token missing the app claim (401)', async () => {
  const token = await signToken({}, 'player-001');
  const { err, req } = await runMiddleware(token);

  assert.equal((err as { status?: number }).status, 401);
  assert.equal(req.auth, undefined);
});

test('allows a request whose path matches the token whitelist', async () => {
  const token = await signToken({ [APP_CLAIM]: APP, whitelist: ['/v1/memcard/*'] }, 'player-001');
  const { err, req } = await runMiddleware(token, MEMCARD_ROUTE);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'player-001', app: APP });
});

test('rejects a request whose path is not in the token whitelist (403)', async () => {
  const token = await signToken({ [APP_CLAIM]: APP, whitelist: ['/nexus/data'] }, 'player-001');
  const { err, req } = await runMiddleware(token, MEMCARD_ROUTE);

  assert.equal((err as { status?: number }).status, 403);
  assert.equal(req.auth, undefined);
});

test('rejects a request whose path is blacklisted, even if whitelisted (403)', async () => {
  const token = await signToken(
    { [APP_CLAIM]: APP, whitelist: ['/v1/memcard/*'], blacklist: ['/v1/memcard/*'] },
    'player-001',
  );
  const { err } = await runMiddleware(token, MEMCARD_ROUTE);

  assert.equal((err as { status?: number }).status, 403);
});
