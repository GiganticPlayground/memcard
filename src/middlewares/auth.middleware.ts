import { createAuthMiddleware, type AuthPaths } from 'token-weaver/auth';

import { config } from '../config/index';
import type { AuthContext } from '../types/express';
import { HttpError } from '../utils/index';

/**
 * Per-path allow/deny configuration. The patterns themselves are carried by the
 * token (in the claims named here); this only tells the middleware which claims
 * to read and how to normalize the request path. A token that omits both claims
 * is authorized purely by verification (no path restriction), preserving the
 * prior behavior. Enforcement is matched against `req.baseUrl + req.path`
 * (i.e. the absolute `/v1/memcard/...` path unless `JWT_PATH_PREFIX` is set).
 */
const authPaths: AuthPaths = {
  whitelistClaim: config.JWT_WHITELIST_CLAIM,
  blacklistClaim: config.JWT_BLACKLIST_CLAIM,
  ...(config.JWT_PATH_PREFIX ? { pathPrefix: config.JWT_PATH_PREFIX } : {}),
};

/**
 * JWT verification middleware.
 *
 * Delegates token verification to the shared, configurable middleware published
 * by token-weaver (`token-weaver/auth`). The verification mode is selected by
 * `JWT_AUTH_MODE`:
 *  - `jwt-jwks`  — RS256 JWT validated against the remote JWKS at `JWKS_URI`.
 *  - `jwt-hs256` — HS256 JWT validated against the shared `JWT_SECRET`.
 *
 * The shared middleware stays consumer-agnostic: it verifies the token and hands
 * the decoded payload to `onVerified`, where we map the Memcard identity onto
 * `req.auth`. Invalid/expired/missing tokens reject with `401` (the lib's
 * `AuthError`, rendered by `errorHandlerMiddleware`) before any S3 access.
 */
export const authMiddleware = createAuthMiddleware({
  mode: config.JWT_AUTH_MODE,
  issuer: config.JWT_ISSUER,
  ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
  ...(config.JWT_AUTH_MODE === 'jwt-jwks' && config.JWKS_URI ? { jwksUri: config.JWKS_URI } : {}),
  ...(config.JWT_AUTH_MODE === 'jwt-hs256' && config.JWT_SECRET
    ? { secret: config.JWT_SECRET }
    : {}),
  // Enforce the token's whitelist/blacklist path claims (403 on a denied path)
  // before onVerified maps the identity. Only active when the token carries them.
  paths: authPaths,
  onVerified: (payload, req) => {
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
  },
});
