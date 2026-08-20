/**
 * Every error this library throws descends from {@link RestError}, so a caller
 * can catch one type and still narrow to the specific failure.
 *
 * The clients this was extracted from threw bare strings (`throw "Cannot build
 * auth headers for url: " + url`), which lose their stack and defeat
 * `instanceof`. Nothing here does that.
 */

/** Context common to every failure: which request was in flight. */
export interface RestErrorContext {
  /** The fully-resolved request URL. */
  url: string;
  /** The HTTP method, upper-cased. */
  method: string;
  /** The underlying error, when this one wraps another. */
  cause?: unknown;
}

/** Base class for errors raised by this library. */
export class RestError extends Error {
  readonly url: string;
  readonly method: string;

  constructor(message: string, context: RestErrorContext) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "RestError";
    this.url = context.url;
    this.method = context.method;
  }
}

/**
 * A response arrived, but its status was not the success the caller required.
 *
 * Raised by {@link ApiResponse.getOrThrow} when no explicit throwable is given,
 * and never raised by the client itself — a non-2xx is a normal return value
 * here, matching the behaviour of the code this replaces.
 */
export class HttpError extends RestError {
  readonly status: number;
  /** The decoded response body, when there was one. */
  readonly body: unknown;

  constructor(message: string, context: RestErrorContext & { status: number; body?: unknown }) {
    super(message, context);
    this.name = "HttpError";
    this.status = context.status;
    this.body = context.body;
  }
}

/** The request exceeded its configured time budget and was aborted. */
export class TimeoutError extends RestError {
  readonly timeoutMs: number;

  constructor(context: RestErrorContext & { timeoutMs: number }) {
    super(`${context.method} ${context.url} timed out after ${context.timeoutMs}ms`, context);
    this.name = "TimeoutError";
    this.timeoutMs = context.timeoutMs;
  }
}

/**
 * `fetch` itself rejected — DNS failure, connection refused, TLS error, or a
 * caller-supplied signal aborting. Distinct from {@link HttpError}, which means
 * the server did answer.
 */
export class NetworkError extends RestError {
  constructor(context: RestErrorContext) {
    super(`${context.method} ${context.url} failed: ${describeCause(context.cause)}`, context);
    this.name = "NetworkError";
  }
}

/** A readable reason for a failure, including when there is no cause to read. */
function describeCause(cause: unknown): string {
  if (cause === undefined || cause === null) return "the request did not complete";
  if (cause instanceof Error) return cause.message || cause.name;
  return String(cause);
}
