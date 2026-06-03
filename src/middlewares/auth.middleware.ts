import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors, type JWTVerifyOptions } from 'jose';

import { config } from '../config/index';
import type { AuthContext } from '../types/express';
import { HttpError, logger } from '../utils/index';

/**
 * Remote JWKS resolver. `jose` caches the keys, refreshes them on a `kid`
 * miss, and applies a cooldown so a flood of unknown-key tokens cannot
 * hammer the auth service.
 */
const jwks = createRemoteJWKSet(new URL(config.JWKS_URI));

const verifyOptions: JWTVerifyOptions = {
  issuer: config.JWT_ISSUER,
  algorithms: ['RS256'],
  ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
};

function extractBearerToken(req: Request): string {
  const header = req.header('authorization');
  if (!header) {
    throw new HttpError(401, 'Missing Authorization header');
  }

  const [scheme, token] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw new HttpError(401, 'Authorization header must be a Bearer token');
  }

  return token;
}

/**
 * Verifies the inbound JWT against the auth service JWKS and attaches the
 * resolved identity to `req.auth`. Rejects with 401 before any S3 access.
 */
export async function authMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const token = extractBearerToken(req);

    const { payload } = await jwtVerify(token, jwks, verifyOptions);

    const userId = payload.sub;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new HttpError(401, 'Token is missing the subject (sub) claim');
    }

    const appClaim = payload[config.JWT_APP_CLAIM];
    if (typeof appClaim !== 'string' || appClaim.length === 0) {
      throw new HttpError(401, `Token is missing the '${config.JWT_APP_CLAIM}' claim`);
    }

    const auth: AuthContext = { userId, app: appClaim };
    req.auth = auth;

    next();
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }

    if (error instanceof joseErrors.JOSEError) {
      logger.warn('JWT verification failed', { code: error.code });
      next(new HttpError(401, 'Invalid or expired token'));
      return;
    }

    next(error);
  }
}
