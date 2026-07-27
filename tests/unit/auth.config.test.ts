import '../setup-env';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Auth config compiler — parses the `auth:` section of the deployment config file
 * and compiles it into token-weaver strategies. The fixtures under
 * `tests/fixtures/` are the same YAML a deployment would ship.
 */
process.env.TEST_PLAYER_SECRET = 'player-secret';
process.env.TEST_INTERNAL_SECRET = 'internal-secret';
process.env.TEST_STATIC_TOKEN = 'static-token';

const { compileAuthConfigFile } = await import('../../src/config/auth.config');

const fixture = (name: string) => `tests/fixtures/auth.${name}.yaml`;

describe('compileAuthConfigFile', () => {
  it('compiles a list of strategies in the declared order', () => {
    const strategies = compileAuthConfigFile(fixture('multi-strategy'));

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
    const [player, internal, staticStrategy] = compileAuthConfigFile(fixture('multi-strategy'));

    assert.equal(player?.options.secret, 'player-secret');
    assert.equal(internal?.options.secret, 'internal-secret');
    assert.equal(staticStrategy?.options.staticToken, 'static-token');
  });

  it('carries per-strategy app claims, defaulting to JWT_APP_CLAIM', () => {
    const [player, internal] = compileAuthConfigFile(fixture('multi-strategy'));

    assert.equal(player?.appClaim, 'app');
    assert.equal(internal?.appClaim, 'tenant');
  });

  it('passes the path rules through to the strategy options', () => {
    const [player] = compileAuthConfigFile(fixture('multi-strategy'));

    assert.deepEqual(player?.options.paths, {
      whitelistClaim: 'whitelist',
      blacklistClaim: 'blacklist',
    });
  });

  it('normalizes a single strategy object into a one-element list', () => {
    const strategies = compileAuthConfigFile(fixture('single'));

    assert.equal(strategies.length, 1);
    assert.equal(strategies[0]?.options.mode, 'jwt-hs256');
  });

  it('rejects a static strategy that is not marked admin', () => {
    assert.throws(
      () => compileAuthConfigFile(fixture('static-not-admin')),
      /cannot identify a player/,
    );
  });

  it('rejects two strategies sharing an issuer', () => {
    assert.throws(
      () => compileAuthConfigFile(fixture('duplicate-issuer')),
      /Duplicate auth issuer/,
    );
  });

  it('fails fast when a referenced env var is unset', () => {
    assert.throws(
      () => compileAuthConfigFile(fixture('missing-env')),
      /TEST_SECRET_THAT_IS_NEVER_SET/,
    );
  });

  it('reports schema violations against the offending file', () => {
    assert.throws(
      () => compileAuthConfigFile(fixture('invalid-type')),
      /Auth config validation failed for tests\/fixtures\/auth\.invalid-type\.yaml/,
    );
  });
});
