import '../setup-env';

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { beforeEach, describe, it } from 'node:test';

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { mockClient } from 'aws-sdk-client-mock';

import { S3StateStore } from '../../src/services/s3.service';
import { StateConflictError, UpstreamUnavailableError } from '../../src/utils/http-error';

const s3Mock = mockClient(S3Client);

function streamBody(payload: unknown) {
  return sdkStreamMixin(Readable.from([Buffer.from(JSON.stringify(payload))]));
}

function s3Error(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(httpStatusCode ? { $metadata: { httpStatusCode } } : {}),
  });
}

const KEY = 'memcard/test/app1/user1/state.json';

describe('S3StateStore.getState', () => {
  beforeEach(() => s3Mock.reset());

  it('returns 200 with etag, lastModified, and parsed body', async () => {
    const stored = {
      schemaVersion: 1,
      lastModifiedAt: '2026-01-01T00:00:00Z',
      state: { coins: 10 },
    };
    s3Mock.on(GetObjectCommand).resolves({
      Body: streamBody(stored),
      ETag: '"v1"',
      LastModified: new Date('2026-01-01T00:00:00Z'),
    });

    const store = new S3StateStore();
    const result = await store.getState(KEY);

    assert.equal(result.status, 200);
    assert.equal(result.etag, '"v1"');
    assert.deepEqual(result.body?.state, { coins: 10 });
    assert.equal(result.lastModified, '2026-01-01T00:00:00.000Z');
  });

  it('returns 304 echoing the supplied If-None-Match when S3 reports NotModified', async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error('NotModified', 304));

    const store = new S3StateStore();
    const result = await store.getState(KEY, '"v1"');

    assert.equal(result.status, 304);
    assert.equal(result.etag, '"v1"');
  });

  it('returns the sentinel etag and empty state when the object does not exist', async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error('NoSuchKey', 404));

    const store = new S3StateStore();
    const result = await store.getState(KEY);

    assert.equal(result.status, 200);
    assert.equal(result.etag, '0');
    assert.deepEqual(result.body?.state, {});
  });

  it('maps timeouts to a 503 UpstreamUnavailableError', async () => {
    s3Mock.on(GetObjectCommand).rejects(s3Error('TimeoutError'));

    const store = new S3StateStore();
    await assert.rejects(
      () => store.getState(KEY),
      (error: UpstreamUnavailableError) => {
        assert.equal(error.status, 503);
        return true;
      },
    );
  });
});

describe('S3StateStore.putState', () => {
  beforeEach(() => s3Mock.reset());

  const stored = { schemaVersion: 1, lastModifiedAt: '2026-01-01T00:00:00Z', state: { coins: 1 } };

  it('writes conditionally with If-Match and returns the new etag', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"v2"' });

    const store = new S3StateStore();
    const result = await store.putState(KEY, stored, '"v1"');

    assert.equal(result.etag, '"v2"');
    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    assert.ok(call);
    const input = call.args[0].input;
    assert.equal(input.IfMatch, '"v1"');
    assert.equal(input.IfNoneMatch, undefined);
  });

  it('translates the sentinel etag into a create-only If-None-Match: *', async () => {
    s3Mock.on(PutObjectCommand).resolves({ ETag: '"v1"' });

    const store = new S3StateStore();
    await store.putState(KEY, stored, '0');

    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    assert.ok(call);
    const input = call.args[0].input;
    assert.equal(input.IfNoneMatch, '*');
    assert.equal(input.IfMatch, undefined);
  });

  it('translates a precondition failure into a 409 conflict with the current etag', async () => {
    s3Mock.on(PutObjectCommand).rejects(s3Error('PreconditionFailed', 412));
    s3Mock.on(HeadObjectCommand).resolves({ ETag: '"current"' });

    const store = new S3StateStore();
    await assert.rejects(
      () => store.putState(KEY, stored, '"stale"'),
      (error: StateConflictError) => {
        assert.equal(error.status, 409);
        assert.equal(error.currentEtag, '"current"');
        return true;
      },
    );
  });
});
