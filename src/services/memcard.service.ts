import type { S3StateStore, StoredStateObject } from './s3.service';
import { config } from '../config/index';
import { PayloadTooLargeError } from '../utils/index';

export interface MemcardStateResponse {
  lastModified?: string;
  state: Record<string, unknown>;
}

export type MemcardFetchResult =
  | { status: 200; etag: string; body: MemcardStateResponse }
  | { status: 304; etag: string };

/**
 * Memcard domain logic: resolves the per-player S3 key, mediates conditional
 * reads/writes, and enforces the configured payload size limit.
 */
export class MemcardService {
  constructor(private readonly store: S3StateStore) {}

  private buildKey(app: string, userId: string): string {
    return `${config.MEMCARD_KEY_PREFIX}/${config.MEMCARD_ENV}/${app}/${userId}/state.json`;
  }

  async fetch(app: string, userId: string, ifNoneMatch?: string): Promise<MemcardFetchResult> {
    const key = this.buildKey(app, userId);
    const result = await this.store.getState(key, ifNoneMatch);

    if (result.status === 304) {
      return { status: 304, etag: result.etag };
    }

    // `body` is always populated on a 200 (both the object-exists and 404
    // bootstrap paths set it), so this fallback is type-safety only: the field
    // is declared optional, so we must handle the `undefined` case.
    const stored = result.body ?? { schemaVersion: config.MEMCARD_SCHEMA_VERSION, state: {} };
    // Prefer S3's authoritative LastModified. Fall back to the timestamp we wrote
    // into the envelope in `save()` for the case where the object exists but the
    // GetObject response omitted LastModified (e.g. an S3-compatible endpoint or a
    // mock). Stays undefined for a brand-new player with no save yet.
    const lastModified = result.lastModified ?? stored.lastModifiedAt;

    return {
      status: 200,
      etag: result.etag,
      body: {
        ...(lastModified ? { lastModified } : {}),
        state: stored.state ?? {},
      },
    };
  }

  async save(
    app: string,
    userId: string,
    ifMatch: string,
    state: Record<string, unknown>,
  ): Promise<{ etag: string }> {
    const byteLength = Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (byteLength > config.MEMCARD_MAX_BODY_BYTES) {
      throw new PayloadTooLargeError(
        `State payload (${byteLength} bytes) exceeds the limit of ${config.MEMCARD_MAX_BODY_BYTES} bytes`,
      );
    }

    const stored: StoredStateObject = {
      schemaVersion: config.MEMCARD_SCHEMA_VERSION,
      lastModifiedAt: new Date().toISOString(),
      state,
    };

    const key = this.buildKey(app, userId);
    return this.store.putState(key, stored, ifMatch);
  }
}
