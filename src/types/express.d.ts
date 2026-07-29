/**
 * Express request augmentation.
 *
 * `req.auth` is populated by the JWT verification middleware and consumed by
 * the Memcard controllers to resolve the per-player S3 object.
 */
export interface AuthContext {
  /** Player identity, taken from the JWT `sub` claim. */
  userId: string;
  /** Application namespace, taken from the configured app claim. */
  app: string;
}

/**
 * Which configured strategy accepted the request. Recorded so the admin
 * controllers can re-check the privilege they depend on instead of trusting
 * that the middleware ran, and so logs can tell the callers apart.
 */
export interface AuthStrategyContext {
  type: 'jwks' | 'hs256' | 'static';
  /** Whether this credential is allowed on the admin routes. */
  admin: boolean;
  /** Issuer of the verified token — absent for a static token. */
  issuer?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      authStrategy?: AuthStrategyContext;
    }
  }
}
