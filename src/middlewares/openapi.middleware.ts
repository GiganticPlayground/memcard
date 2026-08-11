import { existsSync } from 'fs';
import { join } from 'path';

import * as OpenApiValidator from 'express-openapi-validator';

function resolveOperationHandlersPath(): string {
  const sourcePath = join(process.cwd(), 'src/controllers');
  if (existsSync(sourcePath)) {
    return sourcePath;
  }

  return join(process.cwd(), 'dist/src/controllers');
}

/** Either a path to the spec file or the parsed document itself. */
type ApiSpecInput = Parameters<typeof OpenApiValidator.middleware>[0]['apiSpec'];

export const createOpenApiValidatorMiddleware = (apiSpec: unknown) =>
  OpenApiValidator.middleware({
    apiSpec: apiSpec as ApiSpecInput,
    validateApiSpec: true,
    validateRequests: true, // (default)
    validateResponses: false, // false by default
    operationHandlers: resolveOperationHandlersPath(),
  });
