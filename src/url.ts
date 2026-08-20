/** A value that can appear in a query string. */
export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<string | number | boolean>;

/** Query parameters to append to a URL. */
export type QueryParams = Readonly<Record<string, QueryValue>>;

/**
 * Join `path` onto `base`.
 *
 * A leading `/` means "from the root of the base", anything else is appended as
 * a segment. This is the rule every client in the source codebase used, kept
 * as-is so existing paths resolve identically.
 *
 * @throws {TypeError} when `path` is empty or only whitespace — almost always a
 * missing variable rather than a deliberate request for the base URL itself.
 */
export function buildUrl(path: string, base: string): string {
  if (!path || path.trim().length === 0) {
    throw new TypeError(`Invalid path: ${JSON.stringify(path)}`);
  }

  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return path.startsWith("/") ? `${trimmedBase}${path}` : `${trimmedBase}/${path}`;
}

/**
 * Append query parameters to a URL, preserving any it already has.
 *
 * `undefined` and `null` values are skipped rather than serialised as the
 * strings `"undefined"`/`"null"`. An array repeats its key once per element,
 * which is what most servers expect for a multi-valued parameter.
 */
export function withQuery(url: string, params?: QueryParams): string {
  if (!params) return url;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      for (const item of value) search.append(key, String(item));
    } else {
      search.append(key, String(value as string | number | boolean));
    }
  }

  const query = search.toString();
  if (!query) return url;

  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${query}`;
}

/**
 * Turn a map of named base URLs into a map of path builders.
 *
 * Replaces the family of near-identical `somethingPath(path)` helpers that
 * accumulate in an app talking to several backends:
 *
 * ```ts
 * const endpoints = createEndpoints({
 *   billing: "https://billing.example.com",
 *   search: "https://search.example.com",
 * });
 *
 * endpoints.billing("/v1/invoices"); // https://billing.example.com/v1/invoices
 * ```
 */
export function createEndpoints<K extends string>(
  services: Readonly<Record<K, string>>,
): Readonly<Record<K, (path: string) => string>> {
  const entries = Object.entries(services) as Array<[K, string]>;
  const built = {} as Record<K, (path: string) => string>;

  for (const [name, base] of entries) {
    built[name] = (path: string) => buildUrl(path, base);
  }

  return built;
}

/**
 * The longest base URL in `bases` that `url` starts with, or `undefined` when
 * none matches.
 *
 * Longest wins so that overlapping bases resolve to the more specific one — with
 * `https://api.example.com` and `https://api.example.com/search` configured, a
 * search URL picks the latter. Auth schemes that need to know which backend
 * they are talking to (to select an audience, a scope, or a credential) use
 * this; the library itself draws no conclusions from the result.
 */
export function resolveBase(url: string, bases: Iterable<string>): string | undefined {
  let match: string | undefined;

  for (const base of bases) {
    if (!base || !isUnderBase(url, base)) continue;
    if (match === undefined || base.length > match.length) match = base;
  }

  return match;
}

/**
 * Whether `url` genuinely sits under `base`, rather than merely starting with
 * its characters.
 *
 * A plain `startsWith` would report that `https://api.example.com.attacker.test`
 * is under `https://api.example.com`, because the attacker's hostname continues
 * where the trusted one ends. Since the usual reason to resolve a base is to
 * decide which credential a request should carry, that answer is worth getting
 * right: what follows the base has to be nothing at all, or a boundary that
 * ends the authority — a path, a query, or a fragment.
 */
function isUnderBase(url: string, base: string): boolean {
  const normalised = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!url.startsWith(normalised)) return false;

  const rest = url.slice(normalised.length);
  return rest === "" || rest.startsWith("/") || rest.startsWith("?") || rest.startsWith("#");
}
