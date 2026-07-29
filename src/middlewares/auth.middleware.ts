import type { Request } from 'express';
import type { JWTPayload } from 'jose';
import { createAuthMiddleware } from 'token-weaver/auth';

import { config } from '../config/index';
import {
  ADMIN_ROUTE_PREFIX,
  loadAuthStrategies,
  type CompiledAuthStrategy,
} from '../config/memcard-config';
import type { AuthContext, AuthStrategyContext } from '../types/express';
import { HttpError, logger } from '../utils/index';

/**
 * Authentication middleware.
 *
 * Verification is delegated to the shared middleware published by token-weaver
 * (`token-weaver/auth`). Memcard supplies the strategy list — one per kind of
 * caller it accepts — and maps the verified payload onto its own request shape.
 *
 * Strategies are tried in order and the first that accepts the request wins. If
 * every one rejects, the most informative failure is surfaced (a `403` is
 * preferred over a `401`, since "authenticated but not allowed here" tells the
 * caller more than "bad token"). Nothing reaches S3 before this passes.
 *
 * Where the strategies come from is a deployment decision — see
 * `src/config/memcard-config.ts`. That module takes the environment as an
 * argument rather than importing it, so binding the two happens here.
 */
const strategies = loadAuthStrategies(config);

/** Strategies indexed by the issuer of the tokens they verify (JWT strategies only). */
const byIssuer = new Map<string, CompiledAuthStrategy>(
  strategies
    .filter((strategy): strategy is CompiledAuthStrategy & { issuer: string } =>
      Boolean(strategy.issuer),
    )
    .map((strategy) => [strategy.issuer, strategy]),
);

/** First `static` strategy, if any — a static payload carries nothing to match on. */
const staticStrategy = strategies.find((strategy) => strategy.type === 'static');

/**
 * Trace a verified payload back to the strategy that accepted it.
 *
 * token-weaver does not report which strategy won, so we identify it by `iss` —
 * which the config compiler guarantees is unique per JWT strategy. A payload with
 * no `iss` came from a static token, which carries no claims at all.
 */
function strategyFor(payload: JWTPayload): CompiledAuthStrategy | undefined {
  const issuer = payload.iss;
  if (typeof issuer === 'string' && issuer.length > 0) {
    return byIssuer.get(issuer);
  }
  return staticStrategy;
}

/** The path the request resolves to, matching what token-weaver checks. */
function requestPath(req: Request): string {
  return `${req.baseUrl}${req.path}`;
}

/**
 * Map the JWT identity onto `req.auth`.
 *
 * On the player routes this is mandatory — the S3 key is built from it, so a
 * token that cannot name a player is rejected. On the admin routes the target
 * comes from the URL instead, so an identity is recorded when the token happens
 * to carry one and its absence is not an error.
 */
function attachIdentity(
  payload: JWTPayload,
  req: Request,
  strategy: CompiledAuthStrategy,
  optional: boolean,
): void {
  const appClaimName = strategy.appClaim;
  const userId = payload.sub;
  const app = appClaimName ? payload[appClaimName] : undefined;

  const hasUserId = typeof userId === 'string' && userId.length > 0;
  const hasApp = typeof app === 'string' && app.length > 0;

  if (hasUserId && hasApp) {
    const auth: AuthContext = { userId, app };
    req.auth = auth;
    return;
  }

  if (optional) {
    return;
  }

  if (!hasUserId) {
    throw new HttpError(401, 'Token is missing the subject (sub) claim');
  }
  throw new HttpError(401, `Token is missing the '${appClaimName ?? 'app'}' claim`);
}

export const authMiddleware = createAuthMiddleware({
  strategies: strategies.map((strategy) => strategy.options),
  onVerified: (payload, req) => {
    const strategy = strategyFor(payload);
    if (!strategy) {
      // Only reachable if a token verifies under a strategy we cannot trace back,
      // which would mean the issuer map and the strategy list disagree.
      throw new HttpError(401, 'Verified token could not be matched to an auth strategy');
    }

    const isAdminRoute = requestPath(req).startsWith(ADMIN_ROUTE_PREFIX);

    // The admin gate lives here rather than in the strategy's `paths` block: an
    // inline path list would override the token's own whitelist/blacklist claims,
    // and this restriction is a property of the service, not something a
    // deployment should be able to weaken by writing its own patterns.
    if (isAdminRoute && !strategy.admin) {
      throw new HttpError(403, 'This credential is not allowed on the admin routes');
    }

    if (strategy.type === 'static') {
      // Guaranteed by the compiler (a static strategy must be admin), so this is
      // the belt to that suspenders: a static token has no `sub` and could only
      // ever act on a player it cannot name.
      if (!isAdminRoute) {
        throw new HttpError(
          403,
          'A static token cannot access player-scoped routes — it carries no player identity',
        );
      }
      const context: AuthStrategyContext = { type: 'static', admin: true };
      req.authStrategy = context;
      return;
    }

    attachIdentity(payload, req, strategy, isAdminRoute);

    const context: AuthStrategyContext = {
      type: strategy.type,
      admin: strategy.admin,
      ...(strategy.issuer ? { issuer: strategy.issuer } : {}),
    };
    req.authStrategy = context;
  },
});

logger.info(
  `auth: ${strategies.length} ${strategies.length === 1 ? 'strategy' : 'strategies'} (${strategies
    .map((strategy) => `${strategy.type}${strategy.admin ? ':admin' : ''}`)
    .join(', ')})`,
);
