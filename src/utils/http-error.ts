export class HttpError extends Error {
  status: number;
  errors?: unknown;

  constructor(status: number, message: string, errors?: unknown) {
    super(message);
    this.name = 'HTTP_ERROR';
    this.status = status;
    this.errors = errors;
  }
}

export class UpstreamUnavailableError extends HttpError {
  constructor(message = 'Upstream service unavailable') {
    super(503, message);
    this.name = 'UPSTREAM_UNAVAILABLE';
  }
}

/**
 * Raised when a conditional write is rejected because the stored state has
 * advanced past the ETag the client supplied (S3 returns 412 Precondition
 * Failed; we translate it to a domain-level 409 Conflict).
 */
export class StateConflictError extends HttpError {
  readonly currentEtag: string;

  constructor(currentEtag: string, message = 'State was modified since last fetch') {
    super(409, message);
    this.name = 'STATE_CONFLICT';
    this.currentEtag = currentEtag;
  }
}

/**
 * Raised when a PUT body exceeds the configured maximum size.
 */
export class PayloadTooLargeError extends HttpError {
  constructor(message = 'Request body exceeds the maximum allowed size') {
    super(413, message);
    this.name = 'PAYLOAD_TOO_LARGE';
  }
}
