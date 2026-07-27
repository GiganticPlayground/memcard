import { existsSync, readFileSync } from 'fs';
import { extname } from 'path';

import type { AuthPaths, AuthRequirement, AuthStrategyOptions } from 'token-weaver/auth';
import YAML from 'yaml';
import { z } from 'zod';

import { config as env } from './index';

/**
 * Auth configuration.
 *
 * Memcard can accept several kinds of caller at once — mobile players holding a
 * JWT from the auth service, and internal services holding a token of their own.
 * Which strategies exist is declared in a deployment config file (`auth:`), which
 * is compiled here into the `AuthStrategyOptions[]` shape that the shared
 * `token-weaver/auth` middleware consumes. Verification itself stays in that
 * library; this module only parses, validates, and compiles.
 *
 * Secrets never live in the file — `${env:VAR}` placeholders are resolved at
 * startup and a missing var is a hard failure, so the file is safe to commit
 * alongside a deployment.
 *
 * The file is optional. With no file the strategy list is derived from the
 * `JWT_*` env vars, which is exactly the single-strategy behavior Memcard had
 * before this existed.
 */

/** Paths served from an identity carried by the token itself (the `sub`). */
export const PLAYER_ROUTE_PREFIX = '/v1/memcard/me';
/** Paths that take the target player from the URL rather than the token. */
export const ADMIN_ROUTE_PREFIX = '/v1/memcard/admin';

const DEFAULT_CONFIG_PATH = 'config/memcard.yaml';

// ---------------------------------------------------------------------------
// Raw schema (what the file may contain, before env interpolation)
// ---------------------------------------------------------------------------

const rawRequirementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scope'), value: z.string().min(1) }),
  z.object({
    type: z.literal('claim_includes'),
    claim: z.string().min(1),
    value: z.string().min(1),
  }),
]);

const rawPathsSchema = z.object({
  // Stripped from the request path before matching (e.g. a mount prefix).
  pathPrefix: z.string().optional(),
  // Inline patterns are fixed by the deployment and need no claims, so they are the
  // only way to scope a `static` token. NOTE: an inline list REPLACES the matching
  // claim for that side — set `whitelist` and the token's `whitelistClaim` is ignored.
  whitelist: z.array(z.string()).optional(),
  blacklist: z.array(z.string()).optional(),
  // Names of the JWT claims carrying the patterns (JWT strategies only).
  whitelistClaim: z.string().min(1).optional(),
  blacklistClaim: z.string().min(1).optional(),
});

/** Fields every strategy accepts, whatever its type. */
const commonAuthFields = {
  paths: rawPathsSchema.optional(),
  // Whether this strategy may reach the admin routes. Deny by default: a caller
  // that can read any player's state has to be named as such in the config.
  admin: z.boolean().optional().default(false),
};

/** Fields only a JWT-bearing strategy accepts. */
const jwtAuthFields = {
  issuer: z.string().min(1),
  audience: z.string().min(1).optional(),
  requirements: z.array(rawRequirementSchema).optional().default([]),
  // Claim carrying the `{app}` key segment. Falls back to JWT_APP_CLAIM.
  appClaim: z.string().min(1).optional(),
};

const rawJwksAuthSchema = z.object({
  type: z.literal('jwks'),
  jwks_url: z.string().min(1),
  ...jwtAuthFields,
  ...commonAuthFields,
});

const rawHs256AuthSchema = z.object({
  type: z.literal('hs256'),
  secret: z.string().min(1),
  ...jwtAuthFields,
  ...commonAuthFields,
});

const rawStaticAuthSchema = z.object({
  type: z.literal('static'),
  token: z.string().min(1),
  ...commonAuthFields,
});

const rawAuthSchema = z.discriminatedUnion('type', [
  rawJwksAuthSchema,
  rawHs256AuthSchema,
  rawStaticAuthSchema,
]);

type RawAuth = z.infer<typeof rawAuthSchema>;
type RawPaths = z.infer<typeof rawPathsSchema>;

// `auth` accepts a single strategy or a non-empty list of them; a single entry is
// normalized to a one-element list. At runtime the middleware tries each in order.
const rawAuthConfigSchema = z.union([rawAuthSchema, z.array(rawAuthSchema).min(1)]);

// Only `auth` is meaningful today; the file is a service config, so it keeps room
// for future sections rather than being named after this one.
const rawConfigSchema = z.object({
  auth: rawAuthConfigSchema,
});

// ---------------------------------------------------------------------------
// Compiled shape (what the middleware actually uses)
// ---------------------------------------------------------------------------

export interface CompiledAuthStrategy {
  type: RawAuth['type'];
  /** Human-readable label for logs and config errors. */
  label: string;
  /** Verification options handed to token-weaver. */
  options: AuthStrategyOptions;
  /** Issuer of the tokens this strategy verifies — absent for `static`. */
  issuer?: string;
  /** Claim carrying the app namespace — absent for `static`. */
  appClaim?: string;
  /** Whether this strategy may reach the admin routes. */
  admin: boolean;
}

// ---------------------------------------------------------------------------
// Env-placeholder resolution (runs at startup)
// ---------------------------------------------------------------------------

function resolveEnvPlaceholders(value: string, context: string): string {
  return value.replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_match, varName: string) => {
    const resolved = process.env[varName];
    if (resolved === undefined || resolved === '') {
      throw new Error(`Env var "${varName}" referenced in the auth config (${context}) is not set`);
    }
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/** Build a clean AuthPaths, omitting absent keys (exactOptionalPropertyTypes is on). */
function compilePaths(raw: RawPaths | undefined): AuthPaths | undefined {
  if (!raw) return undefined;

  const paths: AuthPaths = {};
  if (raw.pathPrefix !== undefined) paths.pathPrefix = raw.pathPrefix;
  if (raw.whitelist !== undefined) paths.whitelist = raw.whitelist;
  if (raw.blacklist !== undefined) paths.blacklist = raw.blacklist;
  if (raw.whitelistClaim !== undefined) paths.whitelistClaim = raw.whitelistClaim;
  if (raw.blacklistClaim !== undefined) paths.blacklistClaim = raw.blacklistClaim;
  return paths;
}

function compileStrategy(raw: RawAuth, ctx: string): CompiledAuthStrategy {
  const paths = compilePaths(raw.paths);

  if (raw.type === 'static') {
    // A static token carries no claims, so there is no `sub` to resolve a player
    // from. It can only serve the admin routes, where the target comes from the
    // URL — anything else would authenticate a caller we cannot name.
    if (!raw.admin) {
      throw new Error(
        `${ctx}: a "static" strategy cannot identify a player (no claims), so it can only serve ` +
          `the ${ADMIN_ROUTE_PREFIX} routes — set "admin: true" or use a JWT strategy`,
      );
    }

    return {
      type: 'static',
      label: `${ctx} (static)`,
      admin: true,
      options: {
        mode: 'static',
        staticToken: resolveEnvPlaceholders(raw.token, `${ctx}.token`),
        ...(paths ? { paths } : {}),
      },
    };
  }

  const issuer = resolveEnvPlaceholders(raw.issuer, `${ctx}.issuer`);
  const audience = raw.audience
    ? resolveEnvPlaceholders(raw.audience, `${ctx}.audience`)
    : undefined;

  const shared = {
    issuer,
    ...(audience !== undefined ? { audience } : {}),
    ...(raw.requirements.length > 0 ? { requirements: raw.requirements as AuthRequirement[] } : {}),
    ...(paths ? { paths } : {}),
  };

  const options: AuthStrategyOptions =
    raw.type === 'jwks'
      ? {
          mode: 'jwt-jwks',
          jwksUri: resolveEnvPlaceholders(raw.jwks_url, `${ctx}.jwks_url`),
          ...shared,
        }
      : {
          mode: 'jwt-hs256',
          secret: resolveEnvPlaceholders(raw.secret, `${ctx}.secret`),
          ...shared,
        };

  return {
    type: raw.type,
    label: `${ctx} (${raw.type}, issuer ${issuer})`,
    admin: raw.admin,
    issuer,
    appClaim: raw.appClaim ?? env.JWT_APP_CLAIM,
    options,
  };
}

function compileStrategies(raw: RawAuth | RawAuth[]): CompiledAuthStrategy[] {
  const list = Array.isArray(raw) ? raw : [raw];
  // Only index the label when there is more than one, so a single-strategy error
  // reads "auth.secret" rather than "auth[0].secret".
  const compiled = list.map((entry, i) =>
    compileStrategy(entry, list.length > 1 ? `auth[${i}]` : 'auth'),
  );

  // A verified payload is routed back to its strategy by `iss` (see the middleware),
  // so two strategies sharing an issuer would make the app claim ambiguous.
  const byIssuer = new Set<string>();
  for (const strategy of compiled) {
    if (strategy.issuer === undefined) continue;
    if (byIssuer.has(strategy.issuer)) {
      throw new Error(
        `Duplicate auth issuer "${strategy.issuer}" — each JWT strategy needs a distinct issuer ` +
          `so a verified token can be traced back to its configuration`,
      );
    }
    byIssuer.add(strategy.issuer);
  }

  return compiled;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * The single strategy described by the `JWT_*` env vars — what Memcard ran with
 * before the config file existed, and still the default when no file is present.
 * It is never an admin strategy: reading another player's state has to be opted
 * into explicitly, which means writing a config file.
 */
function strategyFromEnv(): RawAuth {
  const paths = {
    whitelistClaim: env.JWT_WHITELIST_CLAIM,
    blacklistClaim: env.JWT_BLACKLIST_CLAIM,
    ...(env.JWT_PATH_PREFIX ? { pathPrefix: env.JWT_PATH_PREFIX } : {}),
  };
  const shared = {
    issuer: env.JWT_ISSUER,
    ...(env.JWT_AUDIENCE ? { audience: env.JWT_AUDIENCE } : {}),
    appClaim: env.JWT_APP_CLAIM,
    requirements: [],
    admin: false,
    paths,
  };

  if (env.JWT_AUTH_MODE === 'jwt-hs256') {
    // The env schema already refuses this combination at startup; the fallback keeps
    // the type honest rather than asserting.
    if (!env.JWT_SECRET) {
      throw new Error('JWT_SECRET is required when JWT_AUTH_MODE=jwt-hs256');
    }
    return { type: 'hs256', secret: env.JWT_SECRET, ...shared };
  }

  if (!env.JWKS_URI) {
    throw new Error('JWKS_URI is required when JWT_AUTH_MODE=jwt-jwks');
  }
  return { type: 'jwks', jwks_url: env.JWKS_URI, ...shared };
}

/** Parse and compile a config file. Exported for tests; prefer `loadAuthStrategies()`. */
export function compileAuthConfigFile(filePath: string): CompiledAuthStrategy[] {
  const contents = readFileSync(filePath, 'utf8');
  const parsed: unknown =
    extname(filePath).toLowerCase() === '.json' ? JSON.parse(contents) : YAML.parse(contents);

  const result = rawConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Auth config validation failed for ${filePath}:\n${issues}`);
  }

  return compileStrategies(result.data.auth);
}

/**
 * Resolve the strategy list for this deployment.
 *
 * An explicit `MEMCARD_CONFIG_PATH` must exist — pointing at a missing file is a
 * configuration mistake, not a reason to silently fall back to a weaker setup.
 * With no explicit path, the default location is used when present, and otherwise
 * the env vars describe a single strategy.
 */
export function loadAuthStrategies(): CompiledAuthStrategy[] {
  const explicitPath = env.MEMCARD_CONFIG_PATH;
  if (explicitPath !== undefined) {
    if (!existsSync(explicitPath)) {
      throw new Error(`Config file not found at MEMCARD_CONFIG_PATH="${explicitPath}"`);
    }
    return compileAuthConfigFile(explicitPath);
  }

  if (existsSync(DEFAULT_CONFIG_PATH)) {
    return compileAuthConfigFile(DEFAULT_CONFIG_PATH);
  }

  return compileStrategies(strategyFromEnv());
}
