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

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
