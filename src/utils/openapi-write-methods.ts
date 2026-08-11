/**
 * Which HTTP method(s) the state-write operations answer on.
 *
 * Routing here is OpenAPI-driven — `express-openapi-validator` dispatches by
 * method *and* path from the spec — so "let clients POST instead of PUT" is a
 * question about the document, not about the controllers. The spec keeps `put`
 * as the one true definition of a write; this transform derives the `post`
 * twin from it at startup, and can drop `put` when a deployment wants POST
 * only (some client stacks and intermediaries cannot be talked into a PUT).
 *
 * The derived operation keeps the original `x-eov-operation-id`, so both
 * methods land on the same controller export and the conditional-write
 * semantics (`If-Match`, `409`) are shared rather than reimplemented.
 */

export type WriteMethod = 'put' | 'post';

interface OperationObject {
  operationId?: string | undefined;
  summary?: string | undefined;
  [key: string]: unknown;
}

type PathItemObject = Record<string, unknown>;

interface SpecDocument {
  paths?: Record<string, PathItemObject>;
  [key: string]: unknown;
}

/** `putMemcardState` → `postMemcardState`; anything else is left alone. */
function deriveOperationId(operationId: string | undefined): string | undefined {
  if (!operationId?.startsWith('put')) {
    return operationId;
  }

  return `post${operationId.slice('put'.length)}`;
}

/**
 * Returns a copy of `spec` whose write operations are exposed on `methods`.
 *
 * `operationId` must stay unique across the document (the spec is validated at
 * startup), so the derived operation gets its own — but `x-eov-operation-id`,
 * which selects the controller export, is copied verbatim.
 */
export function applyWriteMethods(spec: unknown, methods: readonly WriteMethod[]): unknown {
  const document = structuredClone(spec) as SpecDocument;
  const paths = document.paths;
  if (!paths) {
    return document;
  }

  for (const pathItem of Object.values(paths)) {
    const put = pathItem.put as OperationObject | undefined;
    if (!put) {
      continue;
    }

    if (methods.includes('post') && pathItem.post === undefined) {
      pathItem.post = {
        ...put,
        operationId: deriveOperationId(put.operationId),
      } satisfies OperationObject;
    }

    if (!methods.includes('put')) {
      delete pathItem.put;
    }
  }

  return document;
}
