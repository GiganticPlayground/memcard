import '../setup-env';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import YAML from 'yaml';

import { applyWriteMethods } from '../../src/utils/openapi-write-methods';

type Operation = { operationId?: string; 'x-eov-operation-id'?: string };
type PathItem = { get?: Operation; put?: Operation; post?: Operation };
type Spec = { paths: Record<string, PathItem> };

/** The real spec — the transform's only actual input in production. */
function loadSpec(): unknown {
  return YAML.parse(readFileSync(join(process.cwd(), 'api/openapi.yaml'), 'utf8'));
}

const WRITE_PATHS = ['/v1/memcard/me/state', '/v1/memcard/admin/{app}/{userId}/state'];

describe('applyWriteMethods', () => {
  it("leaves the spec's own methods in place for ['put']", () => {
    const spec = applyWriteMethods(loadSpec(), ['put']) as Spec;

    for (const path of WRITE_PATHS) {
      assert.ok(spec.paths[path]?.put, `${path} should keep its put`);
      assert.equal(spec.paths[path]?.post, undefined);
    }
  });

  it("exposes both methods for ['put', 'post']", () => {
    const spec = applyWriteMethods(loadSpec(), ['put', 'post']) as Spec;

    for (const path of WRITE_PATHS) {
      assert.ok(spec.paths[path]?.put);
      assert.ok(spec.paths[path]?.post);
    }
  });

  it("drops put for ['post']", () => {
    const spec = applyWriteMethods(loadSpec(), ['post']) as Spec;

    for (const path of WRITE_PATHS) {
      assert.equal(spec.paths[path]?.put, undefined);
      assert.ok(spec.paths[path]?.post);
    }
  });

  it('gives the derived operation a unique operationId but the same handler', () => {
    const spec = applyWriteMethods(loadSpec(), ['put', 'post']) as Spec;
    const item = spec.paths['/v1/memcard/me/state'];

    assert.equal(item?.put?.operationId, 'putMemcardState');
    assert.equal(item?.post?.operationId, 'postMemcardState');
    // Dispatch is by x-eov-operation-id: both methods must reach one controller.
    assert.equal(item?.post?.['x-eov-operation-id'], item?.put?.['x-eov-operation-id']);
  });

  it('touches only paths that define a write', () => {
    const spec = applyWriteMethods(loadSpec(), ['put', 'post']) as Spec;

    assert.ok(spec.paths['/health']?.get);
    assert.equal(spec.paths['/health']?.post, undefined);
  });

  it('does not mutate the input document', () => {
    const original = loadSpec() as Spec;
    applyWriteMethods(original, ['post']);

    assert.ok(original.paths['/v1/memcard/me/state']?.put);
    assert.equal(original.paths['/v1/memcard/me/state']?.post, undefined);
  });
});
