/** A request about to be sent. */
export interface RequestLogEvent {
  method: string;
  url: string;
  headers: Headers;
  attempt: number;
}

/** A response that arrived. */
export interface ResponseLogEvent extends RequestLogEvent {
  status: number;
  /** Wall-clock time for this attempt, in milliseconds. */
  durationMs: number;
}

/** A request that failed without producing a response. */
export interface ErrorLogEvent extends RequestLogEvent {
  error: unknown;
  durationMs: number;
}

/**
 * Where the client reports what it is doing.
 *
 * Every method is optional, so a partial object is a valid logger.
 */
export interface Logger {
  request?(event: RequestLogEvent): void;
  response?(event: ResponseLogEvent): void;
  error?(event: ErrorLogEvent): void;
  retry?(event: ResponseLogEvent | ErrorLogEvent, delayMs: number): void;
}

/**
 * Header names whose values are never logged.
 *
 * The exact list is deliberately generic: the standard credential-bearing
 * headers, plus a pattern for the custom ones every API invents. A library
 * should not need to know your organisation's header names to avoid printing
 * your tokens.
 */
const REDACTED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
]);

/** Catches `x-api-key`, `x-auth-token`, `x-session-secret`, and friends. */
const REDACTED_PATTERN = /(?:token|secret|api-?key|credential|password|signature|assertion)/i;

/** Whether a header's value should be replaced before logging. */
export function isSensitiveHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return REDACTED_HEADERS.has(lower) || REDACTED_PATTERN.test(lower);
}

/**
 * A plain object of headers with sensitive values replaced by `"<redacted>"`.
 *
 * Names are kept: knowing *that* a request carried an `Authorization` header is
 * exactly what you need when debugging a 401, and the value never is.
 */
export function redactHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  headers.forEach((value, name) => {
    safe[name] = isSensitiveHeader(name) ? "<redacted>" : value;
  });
  return safe;
}

/** A logger that does nothing. The default, because a library should be quiet. */
export const noopLogger: Logger = {};

/**
 * Logs one line per request and response to the console.
 *
 * The format follows the most developed of the clients this library was
 * extracted from: a `[prefix] METHOD url` line on the way out and a
 * `[prefix] METHOD url -> status (Nms)` line on the way back, with anything at
 * 400 or above going to `console.error`.
 */
export function consoleLogger(options?: {
  prefix?: string;
  console?: Pick<Console, "log" | "error" | "warn">;
}): Logger {
  const prefix = options?.prefix ?? "[rest]";
  const out = options?.console ?? console;

  return {
    request({ method, url, attempt }) {
      const suffix = attempt > 1 ? ` (attempt ${attempt})` : "";
      out.log(`${prefix} ${method} ${url}${suffix}`);
    },

    response({ method, url, status, durationMs }) {
      const line = `${prefix} ${method} ${url} -> ${status} (${Math.round(durationMs)}ms)`;
      if (status >= 400) out.error(line);
      else out.log(line);
    },

    error({ method, url, error, durationMs }) {
      out.error(`${prefix} ${method} ${url} failed after ${Math.round(durationMs)}ms:`, error);
    },

    retry(event, delayMs) {
      out.warn(`${prefix} ${event.method} ${event.url} retrying in ${Math.round(delayMs)}ms`);
    },
  };
}
