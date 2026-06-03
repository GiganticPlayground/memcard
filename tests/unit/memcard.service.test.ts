import '../setup-env';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MemcardService } from '../../src/services/memcard.service';
import type { GetStateResult, PutStateResult, S3StateStore } from '../../src/services/s3.service';
import { PayloadTooLargeError } from '../../src/utils/http-error';

type GetCall = { key: string; ifNoneMatch?: string | undefined };
type PutCall = { key: string; stored: unknown; ifMatch: string };

function fakeStore(handlers: {
  getState?: (key: string, ifNoneMatch?: string) => GetStateResult;
  putState?: (key: string, stored: unknown, ifMatch: string) => PutStateResult;
}) {
  const getCalls: GetCall[] = [];
  const putCalls: PutCall[] = [];

  const store = {
    getState: async (key: string, ifNoneMatch?: string) => {
      getCalls.push({ key, ifNoneMatch });
      return (
        handlers.getState?.(key, ifNoneMatch) ?? {
          status: 200,
          etag: '"v1"',
          body: { schemaVersion: 1, state: {} },
        }
      );
    },
    putState: async (key: string, stored: unknown, ifMatch: string) => {
      putCalls.push({ key, stored, ifMatch });
      return handlers.putState?.(key, stored, ifMatch) ?? { etag: '"v2"' };
    },
  } as unknown as S3StateStore;

  return { store, getCalls, putCalls };
}

describe('MemcardService.fetch', () => {
  it('builds the env/app/user-scoped key and returns the response envelope', async () => {
    const { store, getCalls } = fakeStore({
      getState: () => ({
        status: 200,
        etag: '"v1"',
        lastModified: '2026-01-01T00:00:00.000Z',
        body: { schemaVersion: 1, state: { coins: 5 } },
      }),
    });

    const service = new MemcardService(store);
    const result = await service.fetch('app1', 'user1');

    assert.equal(getCalls[0]?.key, 'memcard/test/app1/user1/state.json');
    assert.equal(result.status, 200);
    if (result.status === 200) {
      assert.deepEqual(result.body, {
        lastModified: '2026-01-01T00:00:00.000Z',
        state: { coins: 5 },
      });
    }
  });

  it('passes through a 304 result', async () => {
    const { store } = fakeStore({ getState: () => ({ status: 304, etag: '"v1"' }) });

    const service = new MemcardService(store);
    const result = await service.fetch('app1', 'user1', '"v1"');

    assert.equal(result.status, 304);
    assert.equal(result.etag, '"v1"');
  });
});

describe('MemcardService.save', () => {
  it('wraps the state envelope and forwards the If-Match etag', async () => {
    const { store, putCalls } = fakeStore({});

    const service = new MemcardService(store);
    const result = await service.save('app1', 'user1', '"v1"', { coins: 1 });

    assert.equal(result.etag, '"v2"');
    const put = putCalls[0];
    assert.ok(put);
    assert.equal(put.key, 'memcard/test/app1/user1/state.json');
    assert.equal(put.ifMatch, '"v1"');
    const stored = put.stored as {
      schemaVersion: number;
      lastModifiedAt?: string;
      state: unknown;
    };
    assert.equal(stored.schemaVersion, 1);
    assert.ok(stored.lastModifiedAt);
    assert.deepEqual(stored.state, { coins: 1 });
  });

  it('rejects payloads larger than the configured limit with 413', async () => {
    const { store, putCalls } = fakeStore({});

    const service = new MemcardService(store);
    const oversized = { blob: 'x'.repeat(500) }; // exceeds MEMCARD_MAX_BODY_BYTES=200

    await assert.rejects(
      () => service.save('app1', 'user1', '"v1"', oversized),
      (error: PayloadTooLargeError) => {
        assert.equal(error.status, 413);
        return true;
      },
    );
    assert.equal(putCalls.length, 0);
  });
});
