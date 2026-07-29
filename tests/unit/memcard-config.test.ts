import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  compileAuthConfigFile,
  loadAuthStrategies,
  type AuthEnv,
} from '../../src/config/memcard-config';

/**
 * Auth config compiler — parses the `auth:` section of the deployment config file
 * and compiles it into token-weaver strategies. The fixtures under
 * `tests/fixtures/` are the same YAML a deployment would ship.
 *
 * The module takes what it needs as arguments and never reads the validated env
 * singleton, so this suite imports it statically and skips `../setup-env`: the
 * only environment it needs is the vars the fixtures' `${env:…}` placeholders
 * name, and those are read when a fixture is compiled, not at import.
 */
before(() => {
  process.env.TEST_PLAYER_SECRET = 'player-secret';
  process.env.TEST_INTERNAL_SECRET = 'internal-secret';
  process.env.TEST_STATIC_TOKEN = 'static-token';
  process.env.TEST_ISSUER_HOST = 'issuer.test';
});

/** The deployment's JWT_APP_CLAIM, which a strategy naming none falls back to. */
const DEFAULT_APP_CLAIM = 'app';

const compile = (name: string) =>
  compileAuthConfigFile(`tests/fixtures/auth.${name}.yaml`, DEFAULT_APP_CLAIM);

describe('compileAuthConfigFile', () => {
  it('compiles a list of strategies in the declared order', () => {
    const strategies = compile('multi-strategy');

    assert.deepEqual(
      strategies.map((s) => s.type),
      ['hs256', 'hs256', 'static'],
    );
    assert.deepEqual(
      strategies.map((s) => s.admin),
      [false, true, true],
    );
  });

  it('resolves ${env:VAR} placeholders into the compiled options', () => {
    const [player, internal, staticStrategy] = compile('multi-strategy');

    assert.equal(player?.options.secret, 'player-secret');
    assert.equal(internal?.options.secret, 'internal-secret');
    assert.equal(staticStrategy?.options.staticToken, 'static-token');
  });

  it('carries per-strategy app claims, defaulting to JWT_APP_CLAIM', () => {
    const [player, internal] = compile('multi-strategy');

    assert.equal(player?.appClaim, 'app');
    assert.equal(internal?.appClaim, 'tenant');
  });

  it('passes the path rules through to the strategy options', () => {
    const [player] = compile('multi-strategy');

    assert.deepEqual(player?.options.paths, {
      whitelistClaim: 'whitelist',
      blacklistClaim: 'blacklist',
    });
  });

  it('normalizes a single strategy object into a one-element list', () => {
    const strategies = compile('single');

    assert.equal(strategies.length, 1);
    assert.equal(strategies[0]?.options.mode, 'jwt-hs256');
  });

  it('rejects a static strategy that is not marked admin', () => {
    assert.throws(() => compile('static-not-admin'), /cannot identify a player/);
  });

  it('rejects two strategies sharing an issuer', () => {
    assert.throws(() => compile('duplicate-issuer'), /Duplicate auth issuer/);
  });

  it('fails fast when a referenced env var is unset', () => {
    assert.throws(() => compile('missing-env'), /TEST_SECRET_THAT_IS_NEVER_SET/);
  });

  it('reports schema violations against the offending file', () => {
    assert.throws(
      () => compile('invalid-type'),
      /Auth config validation failed for tests\/fixtures\/auth\.invalid-type\.yaml/,
    );
  });
});

/**
 * A secret may be named three ways — `${env:VAR}`, `${file:PATH}`, or written
 * inline. They are interchangeable and resolve to the same compiled options, so a
 * deployment picks whichever its secret store hands it.
 */
describe('secret sources', () => {
  it('resolves env, file, and literal values into the same compiled shape', () => {
    const [fromEnv, fromFile, fromLiteral] = compile('secret-sources');

    assert.equal(fromEnv?.options.secret, 'player-secret');
    assert.equal(fromFile?.options.staticToken, 'file-sourced-token');
    assert.equal(fromLiteral?.options.secret, 'literal-secret');
  });

  it('strips the trailing newline a mounted secret file carries', () => {
    const [, fromFile] = compile('secret-sources');

    // The fixture ends in "\n"; a bearer token is compared byte for byte, so a
    // surviving newline would reject every request with no visible cause.
    assert.equal(fromFile?.options.staticToken, 'file-sourced-token');
    assert.doesNotMatch(String(fromFile?.options.staticToken), /\s/);
  });

  it('interpolates a placeholder embedded in a larger value', () => {
    const strategies = compile('secret-sources');

    assert.equal(strategies[3]?.issuer, 'https://issuer.test/realm');
  });

  it('fails fast when a referenced secret file is missing', () => {
    assert.throws(
      () => compile('missing-secret-file'),
      /does-not-exist\.secret".*could not be read/s,
    );
  });

  it('fails fast when a referenced secret file is empty', () => {
    assert.throws(() => compile('empty-secret-file'), /is empty/);
  });

  it('rejects a malformed env placeholder instead of passing it through', () => {
    assert.throws(() => compile('malformed-env'), /Malformed placeholder.*TEST-STATIC-TOKEN/s);
  });
});

/**
 * Which of the three sources describes this deployment: an explicit file, the
 * default location, or the JWT_* vars. The environment is a literal here — that
 * is the whole point of it being a parameter.
 */
describe('loadAuthStrategies', () => {
  const env: AuthEnv = {
    JWT_AUTH_MODE: 'jwt-jwks',
    JWKS_URI: 'https://auth.test/.well-known/jwks.json',
    JWT_ISSUER: 'https://auth.test',
    JWT_APP_CLAIM: 'app',
    JWT_WHITELIST_CLAIM: 'whitelist',
    JWT_BLACKLIST_CLAIM: 'blacklist',
  };

  it('derives one non-admin strategy from the env when no file is configured', () => {
    // Assumes no config/memcard.yaml in the working tree — nothing commits one,
    // the committed template is config/memcard.yaml.example.
    const strategies = loadAuthStrategies(env);

    assert.equal(strategies.length, 1);
    assert.equal(strategies[0]?.type, 'jwks');
    assert.equal(strategies[0]?.admin, false, 'admin access requires writing a config file');
    assert.equal(strategies[0]?.appClaim, 'app');
    assert.deepEqual(strategies[0]?.options.paths, {
      whitelistClaim: 'whitelist',
      blacklistClaim: 'blacklist',
    });
  });

  it('compiles the file named by MEMCARD_CONFIG_PATH instead', () => {
    const strategies = loadAuthStrategies({
      ...env,
      MEMCARD_CONFIG_PATH: 'tests/fixtures/auth.multi-strategy.yaml',
    });

    assert.equal(strategies.length, 3);
  });

  it('refuses an explicit path that does not exist rather than weakening auth', () => {
    assert.throws(
      () => loadAuthStrategies({ ...env, MEMCARD_CONFIG_PATH: 'tests/fixtures/nope.yaml' }),
      /Config file not found/,
    );
  });
});
