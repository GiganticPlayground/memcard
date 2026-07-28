import { z } from 'zod';

/** Characters accepted in a key path segment, kept deliberately narrower than S3's. */
const KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/**
 * A variable that becomes part of the S3 object key (`MEMCARD_KEY_PREFIX`,
 * `MEMCARD_ENV`).
 *
 * These are concatenated into the key, so a stray slash or a `..` silently moves
 * every state object — to the bucket root, or into another producer's tree when
 * the bucket is shared. Surrounding slashes are normalized away so `saves`,
 * `/saves` and `saves/` name the same place; anything that could still corrupt
 * the key fails the boot instead of producing a surprising layout.
 *
 * Multi-level values are allowed (`team-a/memcard`), the bucket root is not:
 * Memcard shares buckets with other services, so "no prefix" is a mistake rather
 * than a configuration.
 */
function keyPathVar(label: string, defaultValue?: string) {
  const base =
    defaultValue === undefined ? z.string() : z.string().optional().default(defaultValue);

  return base
    .transform((value) => value.trim().replace(/^\/+|\/+$/g, ''))
    .pipe(
      z
        .string()
        .min(1, {
          error: `${label} cannot be empty — Memcard does not write to the bucket root`,
        })
        .refine((value) => KEY_SEGMENT_PATTERN.test(value), {
          error:
            `${label} must be one or more '/'-separated segments of letters, digits, ` +
            `'.', '_' or '-' (got an empty segment, whitespace, or an unsupported character)`,
        })
        .refine(
          (value) => !value.split('/').some((segment) => segment === '.' || segment === '..'),
          {
            error: `${label} cannot contain '.' or '..' path segments`,
          },
        ),
    );
}

/**
 * Environment variables validation schema.
 *
 * - Optional variables will use their default values if not provided
 * - Required variables will cause the application to fail on startup if missing
 */
export const envSchema = z
  .object({
    PORT: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().min(1).max(65535))
      .optional()
      .default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).optional().default('development'),
    LOG_LEVEL: z
      .enum(['silly', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'])
      .optional()
      .default('debug'),
    LOG_TYPE: z.enum(['json', 'pretty', 'hidden']).optional().default('pretty'),
    CORS_ORIGINS: z
      .string()
      .optional()
      .transform((value) => {
        if (!value) {
          return undefined;
        }

        if (value === '*') {
          return '*';
        }

        const origins = value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0);

        return origins.length > 0 ? origins : undefined;
      }),
    TRUST_PROXY: z
      .string()
      .optional()
      .default('false')
      .transform((value) => {
        if (!value || value === 'false') {
          return false;
        }

        if (value === 'true') {
          return true;
        }

        const parsed = parseInt(value, 10);
        return Number.isNaN(parsed) ? false : parsed;
      }),
    API_DOCS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .default('true')
      .transform((value) => value === 'true'),
    RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((value) => value === 'true'),
    RATE_LIMIT_MAX: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(30),
    RATE_LIMIT_WINDOW_MS: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(60_000),
    // --- AWS / S3 ---
    AWS_REGION: z.string().min(1),
    MEMCARD_S3_BUCKET: z.string().min(1),
    // Both of these land in the object key — see `keyPathVar` for the rules.
    MEMCARD_ENV: keyPathVar('MEMCARD_ENV'),
    MEMCARD_KEY_PREFIX: keyPathVar('MEMCARD_KEY_PREFIX', 'memcard'),
    MEMCARD_MAX_BODY_BYTES: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(2_097_152),
    MEMCARD_SENTINEL_ETAG: z.string().min(1).optional().default('0'),
    MEMCARD_SCHEMA_VERSION: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(1),
    MEMCARD_S3_TIMEOUT_MS: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(5_000),
    // Optional explicit S3 endpoint (e.g. LocalStack); unset uses the default AWS endpoint.
    MEMCARD_S3_ENDPOINT: z.string().url().optional(),
    MEMCARD_S3_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((value) => value === 'true'),
    // --- JWT verification (tokens issued by the auth service / Token Weaver) ---
    // Verification mode: an RS256 JWT validated against a remote JWKS, or an HS256
    // JWT validated against a shared secret. Defaults to JWKS (the prior behavior).
    JWT_AUTH_MODE: z.enum(['jwt-jwks', 'jwt-hs256']).optional().default('jwt-jwks'),
    // Required when JWT_AUTH_MODE=jwt-jwks (enforced by the refinement below).
    JWKS_URI: z.string().url().optional(),
    // Required when JWT_AUTH_MODE=jwt-hs256 (enforced by the refinement below).
    JWT_SECRET: z.string().min(1).optional(),
    JWT_ISSUER: z.string().min(1),
    JWT_AUDIENCE: z.string().min(1).optional(),
    JWT_APP_CLAIM: z.string().min(1).optional().default('app'),
    // --- Per-path authorization (allow/deny lists carried in the token) ---
    // The issuer (Token Weaver) puts allowed/denied path patterns in these
    // claims; this service only names which claims to read. Enforcement is
    // opt-in per token: a token that omits the claim is unaffected.
    JWT_WHITELIST_CLAIM: z.string().min(1).optional().default('whitelist'),
    JWT_BLACKLIST_CLAIM: z.string().min(1).optional().default('blacklist'),
    // Optional mount prefix stripped from the request path before matching the
    // whitelist/blacklist patterns. Leave unset to match the absolute path
    // (e.g. /v1/memcard/...), which keeps patterns service-specific.
    JWT_PATH_PREFIX: z.string().min(1).optional(),
    // --- Deployment config file (auth strategies) ---
    // Path to the YAML/JSON config file carrying the `auth:` section. Unset falls
    // back to ./config/memcard.yaml when that file exists; with neither, auth is
    // built from the JWT_* vars above as a single strategy (the prior behavior).
    // Setting this to a path that does not exist is an error, not a fallback.
    MEMCARD_CONFIG_PATH: z.string().min(1).optional(),
    // --- Request analytics (reqcast) ---
    // Path to a reqcast config file. Unset falls back to ./reqcast.config.json
    // when that file exists; otherwise analytics stay disabled.
    REQCAST_CONFIG: z.string().optional(),
    SHUTDOWN_TIMEOUT_MS: z
      .string()
      .transform((val) => parseInt(val, 10))
      .pipe(z.number().int().positive())
      .optional()
      .default(30_000),
  })
  // Mode-dependent requirements: the secret/JWKS var is only mandatory for the
  // active mode, so the app still fails fast on an inconsistent configuration.
  .superRefine((env, ctx) => {
    if (env.JWT_AUTH_MODE === 'jwt-jwks' && !env.JWKS_URI) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWKS_URI'],
        message: 'JWKS_URI is required when JWT_AUTH_MODE=jwt-jwks',
      });
    }
    if (env.JWT_AUTH_MODE === 'jwt-hs256' && !env.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required when JWT_AUTH_MODE=jwt-hs256',
      });
    }
  });

/**
 * Inferred TypeScript type from the environment schema
 */
export type Env = z.infer<typeof envSchema>;
