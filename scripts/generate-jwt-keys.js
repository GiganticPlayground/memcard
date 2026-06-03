#!/usr/bin/env node
// Generate an RSA keypair for the local dev auth stack (Token Weaver).
//
// Token Weaver signs RS256 JWTs with this private key and publishes the matching
// public key via its JWKS, which Memcard uses to verify tokens. The keys are
// dev-only secrets and are NOT committed — run this once after cloning:
//
//   yarn dev:keys
//
// Output (default): dev/token-weaver/keys/{private-key.pem,public-key.pem}
// The private key is PKCS8 PEM and the public key is SPKI PEM — the formats
// Token Weaver expects.

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const part = process.argv[index];
  if (part.startsWith('--')) {
    args.set(part, process.argv[index + 1]);
    index += 1;
  }
}

const outDir = resolve(args.get('--out-dir') ?? 'dev/token-weaver/keys');
const privateKeyPath = resolve(outDir, 'private-key.pem');
const publicKeyPath = resolve(outDir, 'public-key.pem');
const force = args.has('--force');

if (!force && existsSync(privateKeyPath)) {
  console.log(`Keys already exist at ${outDir} — nothing to do (use --force to overwrite).`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

writeFileSync(privateKeyPath, privateKey, 'utf8');
writeFileSync(publicKeyPath, publicKey, 'utf8');

console.log(`Generated RSA keypair for the dev auth stack:
- private key: ${privateKeyPath}
- public key:  ${publicKeyPath}

You can now start the stack: docker compose -f docker-compose.dev.yml up -d --build`);
