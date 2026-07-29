import '../setup-env';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { envSchema } from '../../src/config/env.validation';

/**
 * `MEMCARD_KEY_PREFIX` and `MEMCARD_ENV` are concatenated into the S3 object
 * key, so their normalization is part of the storage contract: the bucket is
 * shared with other producers, and a prefix that resolves differently than
 * intended does not fail loudly — a missing object reads as a brand-new player.
 * These cases pin the normalization rather than the concatenation.
 */

/** The env vars the schema requires, so each case only varies what it tests. */
const base = {
  AWS_REGION: 'us-east-1',
  MEMCARD_S3_BUCKET: 'test-bucket',
  MEMCARD_ENV: 'dev',
  JWKS_URI: 'https://auth.test/.well-known/jwks.json',
  JWT_ISSUER: 'https://auth.test',
};

function parse(overrides: Record<string, string>) {
  return envSchema.safeParse({ ...base, ...overrides });
}

function parsed(overrides: Record<string, string>) {
  const result = parse(overrides);
  assert.ok(result.success, `expected a valid config, got: ${result.error?.message}`);
  return result.data;
}

function rejects(overrides: Record<string, string>, expectedPath: string) {
  const result = parse(overrides);
  assert.equal(result.success, false, `expected ${expectedPath} to be rejected`);
  assert.ok(
    result.error?.issues.some((issue) => issue.path.join('.') === expectedPath),
    `expected an issue on ${expectedPath}, got ${JSON.stringify(result.error?.issues)}`,
  );
}

describe('MEMCARD_KEY_PREFIX normalization', () => {
  it('defaults to `memcard` when unset', () => {
    assert.equal(parsed({}).MEMCARD_KEY_PREFIX, 'memcard');
  });

  it('takes an explicit value over the default', () => {
    assert.equal(parsed({ MEMCARD_KEY_PREFIX: 'saves' }).MEMCARD_KEY_PREFIX, 'saves');
  });

  it('strips surrounding slashes so `/x/`, `x/` and `x` name the same place', () => {
    for (const value of ['/saves/', 'saves/', '/saves', 'saves']) {
      assert.equal(parsed({ MEMCARD_KEY_PREFIX: value }).MEMCARD_KEY_PREFIX, 'saves');
    }
  });

  it('trims surrounding whitespace', () => {
    assert.equal(parsed({ MEMCARD_KEY_PREFIX: '  saves  ' }).MEMCARD_KEY_PREFIX, 'saves');
  });

  it('accepts a multi-level prefix', () => {
    assert.equal(
      parsed({ MEMCARD_KEY_PREFIX: '/team-a/memcard/' }).MEMCARD_KEY_PREFIX,
      'team-a/memcard',
    );
  });

  it('rejects an empty prefix — the bucket root is not a valid location', () => {
    rejects({ MEMCARD_KEY_PREFIX: '' }, 'MEMCARD_KEY_PREFIX');
    rejects({ MEMCARD_KEY_PREFIX: '   ' }, 'MEMCARD_KEY_PREFIX');
    rejects({ MEMCARD_KEY_PREFIX: '///' }, 'MEMCARD_KEY_PREFIX');
  });

  it('rejects an empty inner segment', () => {
    rejects({ MEMCARD_KEY_PREFIX: 'team-a//memcard' }, 'MEMCARD_KEY_PREFIX');
  });

  it('rejects traversal segments', () => {
    rejects({ MEMCARD_KEY_PREFIX: '../uni-ipb' }, 'MEMCARD_KEY_PREFIX');
    rejects({ MEMCARD_KEY_PREFIX: 'memcard/./saves' }, 'MEMCARD_KEY_PREFIX');
  });

  it('rejects characters that would corrupt the key', () => {
    // Surrounding whitespace is trimmed, so only interior whitespace can survive
    // to this check — `'saves\n'` is a valid `saves`, `'sa\nves'` is not.
    for (const value of ['my saves', 'saves\\state', 'sa\nves', 'saves?x=1', 'saves#1']) {
      rejects({ MEMCARD_KEY_PREFIX: value }, 'MEMCARD_KEY_PREFIX');
    }
  });
});

describe('MEMCARD_ENV normalization', () => {
  it('applies the same rules as the prefix', () => {
    assert.equal(parsed({ MEMCARD_ENV: '/prod/' }).MEMCARD_ENV, 'prod');
    rejects({ MEMCARD_ENV: '' }, 'MEMCARD_ENV');
    rejects({ MEMCARD_ENV: '..' }, 'MEMCARD_ENV');
    rejects({ MEMCARD_ENV: 'stg 2' }, 'MEMCARD_ENV');
  });

  it('stays required and free-form — the vocabulary is the deployment’s choice', () => {
    for (const value of ['dev', 'prod-us-east', 'client_a.v2']) {
      assert.equal(parsed({ MEMCARD_ENV: value }).MEMCARD_ENV, value);
    }
    const result = envSchema.safeParse({ ...base, MEMCARD_ENV: undefined });
    assert.equal(result.success, false);
  });
});

describe('resolved object key', () => {
  it('uses the normalized segments', async () => {
    process.env.MEMCARD_KEY_PREFIX = '/team-a/memcard/';
    process.env.MEMCARD_ENV = 'prod/';

    // Imported here, not at the top: the config singleton validates the
    // environment at import time, so the vars above have to be set first.
    const { buildStateKey } = await import('../../src/services/memcard.service');

    assert.equal(
      buildStateKey('app1', 'user1'),
      'team-a/memcard/prod/app1/user1/state.json',
      'no double slashes, no leading slash',
    );
  });
});
