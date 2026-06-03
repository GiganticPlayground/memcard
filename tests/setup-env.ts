/**
 * Test environment bootstrap.
 *
 * Imported first by every test file so the required env vars exist before the
 * config module validates them at import time. Values are only set when not
 * already provided, so a real environment can override them.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_TYPE: 'hidden',
  AWS_REGION: 'us-east-1',
  MEMCARD_S3_BUCKET: 'test-bucket',
  MEMCARD_ENV: 'test',
  MEMCARD_MAX_BODY_BYTES: '200',
  JWKS_URI: 'https://auth.test/.well-known/jwks.json',
  JWT_ISSUER: 'https://auth.test',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
