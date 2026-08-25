import assert from 'node:assert/strict';
import test from 'node:test';

import type { NextFunction, Request, Response } from 'express';
import { SignJWT } from 'jose';

/**
 * A strategy whose `{app}` key segment is fixed by the deployment config rather
 * than read from a claim (`tests/fixtures/auth.fixed-app.yaml`) — for an auth
 * service that issues perfectly good tokens but does not put an app in them.
 *
 * Env vars are set *before* the middleware (and therefore the config singleton)
 * is imported, so the import below is dynamic. `node --test` isolates each test
 * file in its own process.
 */
const PLAYER_ISSUER = 'https://players.test';
const TOOLS_ISSUER = 'https://tools.test';
const PLAYER_SECRET = 'player-secret';
const TOOLS_SECRET = 'internal-secret';

process.env.NODE_ENV = 'test';
process.env.LOG_TYPE = 'hidden';
process.env.AWS_REGION = 'us-east-1';
process.env.MEMCARD_S3_BUCKET = 'test-bucket';
process.env.MEMCARD_ENV = 'test';
process.env.JWT_ISSUER = PLAYER_ISSUER;
process.env.JWKS_URI = 'https://players.test/.well-known/jwks.json';
process.env.TEST_PLAYER_SECRET = PLAYER_SECRET;
process.env.TEST_INTERNAL_SECRET = TOOLS_SECRET;
process.env.TEST_FIXED_APP = 'fixed-from-env';
process.env.MEMCARD_CONFIG_PATH = 'tests/fixtures/auth.fixed-app.yaml';

const { authMiddleware } = await import('../../src/middlewares/auth.middleware');

function signToken(
  issuer: string,
  secret: string,
  claims: Record<string, unknown>,
  sub = 'player-001',
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(issuer)
    .setSubject(sub)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

function runMiddleware(token: string): Promise<{ err: unknown; req: Request }> {
  return new Promise((resolve) => {
    const req = {
      headers: { authorization: `Bearer ${token}` },
      baseUrl: '/v1/memcard',
      path: '/me/state',
    } as unknown as Request;
    const res = {} as Response;
    const next: NextFunction = (err?: unknown) => resolve({ err, req });
    void authMiddleware(req, res, next);
  });
}

test('accepts a token with no app claim and takes the app from the config', async () => {
  const token = await signToken(PLAYER_ISSUER, PLAYER_SECRET, {});
  const { err, req } = await runMiddleware(token);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'player-001', app: 'snw-mobile' });
});

test('ignores an app claim the token happens to carry', async () => {
  // The strategy names no claim to read, so a claim cannot redirect a write into
  // another app's tree.
  const token = await signToken(PLAYER_ISSUER, PLAYER_SECRET, { app: 'someone-elses-game' });
  const { err, req } = await runMiddleware(token);

  assert.equal(err, undefined);
  assert.equal(req.auth?.app, 'snw-mobile');
});

test('resolves a fixed app given as an ${env:VAR} placeholder', async () => {
  const token = await signToken(TOOLS_ISSUER, TOOLS_SECRET, {}, 'player-002');
  const { err, req } = await runMiddleware(token);

  assert.equal(err, undefined);
  assert.deepEqual(req.auth, { userId: 'player-002', app: 'fixed-from-env' });
});

test('still requires a subject, since the app alone cannot name a player', async () => {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(PLAYER_ISSUER)
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(PLAYER_SECRET));
  const { err } = await runMiddleware(token);

  assert.equal((err as { status?: number } | undefined)?.status, 401);
  assert.match(String((err as Error).message), /subject \(sub\) claim/);
});
