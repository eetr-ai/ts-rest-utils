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
const REDACTED_PATTERN = /(?:token|secret|api[-_]?key|credential|password|signature|assertion)/i;

/**
 * Query parameters whose values are never logged.
 *
 * Credentials are not supposed to travel in a URL, and they do anyway —
 * `?access_token=`, a signed download link, an OAuth `code` on a redirect. A
 * logged URL outlives the request, so the same rule that applies to headers
 * applies here.
 */
const REDACTED_PARAM =
  /(?:token|secret|api[-_]?key|credential|password|signature|assertion|^code$|^sig$)/i;

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

/**
 * A URL safe to write to a log, with credentials replaced wherever they hide.
 *
 * Three places, all of which happen in practice:
 *
 * - the query string (`?access_token=`, a signed link)
 * - the fragment, which is where an OAuth implicit-flow redirect puts a token
 * - the userinfo of `https://user:password@host`
 *
 * Names are kept and values replaced, as with headers: knowing a request
 * carried an `access_token` is useful, and knowing its value never is. A URL
 * that cannot be parsed is returned unchanged rather than dropped, since a
 * malformed URL is usually the thing being debugged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let changed = false;

  // Credentials in the authority. A password is always sensitive; a bare
  // username is an identifier, and identifying the caller is half of what a
  // log is for.
  if (parsed.password !== "") {
    parsed.password = "<redacted>";
    changed = true;
  }

  // The snapshot is load-bearing: `set` collapses repeated keys into one entry,
  // so `?token=a&token=b` shortens the list mid-iteration and a live iterator
  // would skip the remainder, leaving a secret unredacted.
  // oxlint-disable-next-line no-useless-spread
  for (const name of [...parsed.searchParams.keys()]) {
    if (!REDACTED_PARAM.test(name)) continue;
    parsed.searchParams.set(name, "<redacted>");
    changed = true;
  }

  const fragment = redactFragment(parsed.hash);
  if (fragment !== parsed.hash) {
    parsed.hash = fragment;
    changed = true;
  }

  return changed ? parsed.toString() : url;
}

/**
 * Redact a fragment that carries parameters.
 *
 * An OAuth implicit-flow redirect returns the token here rather than in the
 * query, precisely so it is not sent to the server — which does nothing to stop
 * a client logging the whole URL. A fragment that is a plain anchor has no `=`
 * in it and is left alone.
 */
function redactFragment(hash: string): string {
  if (hash.length <= 1 || !hash.includes("=")) return hash;

  const params = new URLSearchParams(hash.slice(1));
  let changed = false;

  // Snapshotted for the same reason as above.
  // oxlint-disable-next-line no-useless-spread
  for (const name of [...params.keys()]) {
    if (!REDACTED_PARAM.test(name)) continue;
    params.set(name, "<redacted>");
    changed = true;
  }

  return changed ? `#${params.toString()}` : hash;
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
      out.log(`${prefix} ${method} ${redactUrl(url)}${suffix}`);
    },

    response({ method, url, status, durationMs }) {
      const line = `${prefix} ${method} ${redactUrl(url)} -> ${status} (${Math.round(durationMs)}ms)`;
      if (status >= 400) out.error(line);
      else out.log(line);
    },

    error({ method, url, error, durationMs }) {
      out.error(
        `${prefix} ${method} ${redactUrl(url)} failed after ${Math.round(durationMs)}ms:`,
        error,
      );
    },

    retry(event, delayMs) {
      out.warn(
        `${prefix} ${event.method} ${redactUrl(event.url)} retrying in ${Math.round(delayMs)}ms`,
      );
    },
  };
}
