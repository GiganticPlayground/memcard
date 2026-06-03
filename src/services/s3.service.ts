import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { config } from '../config/index';
import { StateConflictError, UpstreamUnavailableError, logger } from '../utils/index';

/**
 * Shape of the object persisted in S3 (the service-owned envelope around the
 * client `state` blob). ETags are managed by S3 and treated as opaque.
 */
export interface StoredStateObject {
  schemaVersion: number;
  lastModifiedAt?: string;
  state: Record<string, unknown>;
}

export interface GetStateResult {
  status: 200 | 304;
  etag: string;
  lastModified?: string;
  body?: StoredStateObject;
}

export interface PutStateResult {
  etag: string;
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function errorName(error: unknown): string {
  return (error as { name?: string })?.name ?? '';
}

function isNotModified(error: unknown): boolean {
  return httpStatus(error) === 304 || errorName(error) === 'NotModified';
}

function isNotFound(error: unknown): boolean {
  return httpStatus(error) === 404 || errorName(error) === 'NoSuchKey';
}

function isPreconditionFailed(error: unknown): boolean {
  return httpStatus(error) === 412 || errorName(error) === 'PreconditionFailed';
}

/**
 * A timeout, aborted request, missing HTTP response, or upstream 5xx all mean
 * S3 is effectively unavailable for this request.
 */
function isUnavailable(error: unknown): boolean {
  const name = errorName(error);
  if (name === 'AbortError' || name === 'TimeoutError') {
    return true;
  }
  const status = httpStatus(error);
  return status === undefined || status >= 500;
}

function toUnavailable(error: unknown): never {
  if (isUnavailable(error)) {
    const isTimeout = ['AbortError', 'TimeoutError'].includes(errorName(error));
    throw new UpstreamUnavailableError(
      isTimeout ? 'S3 request timed out' : 'S3 is currently unavailable',
    );
  }
  throw error;
}

function emptyState(): StoredStateObject {
  return { schemaVersion: config.MEMCARD_SCHEMA_VERSION, state: {} };
}

/**
 * Conditional read/write access to per-player state objects in S3, mapping S3
 * conditional semantics onto the Memcard domain (sentinel bootstrap, 304, and
 * 412 -> 409 conflict).
 */
export class S3StateStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.client = new S3Client({
      region: config.AWS_REGION,
      forcePathStyle: config.MEMCARD_S3_FORCE_PATH_STYLE,
      ...(config.MEMCARD_S3_ENDPOINT ? { endpoint: config.MEMCARD_S3_ENDPOINT } : {}),
    });
    this.bucket = config.MEMCARD_S3_BUCKET;
  }

  private get abortSignal(): AbortSignal {
    return AbortSignal.timeout(config.MEMCARD_S3_TIMEOUT_MS);
  }

  /**
   * Fetch state. With `ifNoneMatch`, a matching object yields a 304. A missing
   * object yields the sentinel ETag with an empty state (first-fetch bootstrap).
   */
  async getState(key: string, ifNoneMatch?: string): Promise<GetStateResult> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
        }),
        { abortSignal: this.abortSignal },
      );

      const text = (await response.Body?.transformToString()) ?? '';
      const body = text ? (JSON.parse(text) as StoredStateObject) : emptyState();

      return {
        status: 200,
        etag: response.ETag ?? '',
        ...(response.LastModified ? { lastModified: response.LastModified.toISOString() } : {}),
        body,
      };
    } catch (error) {
      if (isNotModified(error)) {
        return { status: 304, etag: ifNoneMatch ?? '' };
      }
      if (isNotFound(error)) {
        return { status: 200, etag: config.MEMCARD_SENTINEL_ETAG, body: emptyState() };
      }
      return toUnavailable(error);
    }
  }

  /**
   * Conditionally write state. The sentinel ETag is translated to
   * `If-None-Match: *` (create-only). A precondition failure becomes a
   * 409 conflict carrying the current ETag.
   */
  async putState(key: string, stored: StoredStateObject, ifMatch: string): Promise<PutStateResult> {
    const conditional =
      ifMatch === config.MEMCARD_SENTINEL_ETAG ? { IfNoneMatch: '*' } : { IfMatch: ifMatch };

    try {
      const response = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: JSON.stringify(stored),
          ContentType: 'application/json',
          ...conditional,
        }),
        { abortSignal: this.abortSignal },
      );

      return { etag: response.ETag ?? '' };
    } catch (error) {
      if (isPreconditionFailed(error)) {
        const currentEtag = await this.readCurrentEtag(key);
        logger.warn('Conditional write rejected — state conflict', { key, currentEtag });
        throw new StateConflictError(currentEtag);
      }
      return toUnavailable(error);
    }
  }

  private async readCurrentEtag(key: string): Promise<string> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: this.abortSignal },
      );
      return head.ETag ?? config.MEMCARD_SENTINEL_ETAG;
    } catch (error) {
      if (isNotFound(error)) {
        // Object was removed between the failed write and this read.
        return config.MEMCARD_SENTINEL_ETAG;
      }
      return toUnavailable(error);
    }
  }
}
