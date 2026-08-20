import type { AuthProvider } from "../client.js";

import { OAuthError } from "./errors.js";
import { type StoredToken, type TokenStore, memoryTokenStore } from "./store.js";

/** How the client authenticates to the token endpoint. */
export type ClientAuthMethod = "client_secret_basic" | "client_secret_post";

/** How to obtain a token with the client-credentials grant. */
export interface ClientCredentialsConfig {
  /** The authorization server's token endpoint. */
  tokenUrl: string;
  clientId: string;
  /** Omit when authenticating with {@link clientAssertion} instead. */
  clientSecret?: string;
  /** Requested scope. An array is joined with spaces, as the spec requires. */
  scope?: string | readonly string[];
  /** RFC 8707 resource indicators. Repeated once per value. */
  resource?: string | readonly string[];

  /**
   * How to present the client credentials.
   * @default "client_secret_basic", which OAuth 2.1 prefers
   */
  authMethod?: ClientAuthMethod;

  /**
   * Produces a signed client assertion (`private_key_jwt`), replacing the
   * secret.
   *
   * Supplied as a callback rather than built here on purpose: signing a JWT
   * means a crypto and key-handling dependency, and this package has none.
   * Sign it however you already sign things and hand the result over.
   */
  clientAssertion?: () => string | Promise<string>;

  /** Where tokens are cached. @default an in-process store */
  store?: TokenStore;

  /**
   * Seconds before actual expiry at which a token is treated as expired.
   * @default 60
   */
  expirySkewSeconds?: number;

  /** The `fetch` to use. @default globalThis.fetch */
  fetch?: typeof fetch;

  /**
   * Abort a token request that takes longer than this, in milliseconds.
   *
   * A client that bounds its own requests already covers the provider it calls,
   * but nothing bounds `getToken` when it is used directly, nor a client with
   * no `timeoutMs` of its own.
   */
  timeoutMs?: number;

  /** Header to carry the token. @default "Authorization" */
  headerName?: string;
  /** Scheme prefixed to the token. @default the server's token_type, or "Bearer" */
  scheme?: string;
}

/** A client-credentials provider, plus the controls a caller needs around it. */
export interface ClientCredentialsAuth<Ctx = unknown> {
  /** Pass this as the client's `authProvider`. */
  readonly authProvider: AuthProvider<Ctx>;
  /**
   * Ready to pass as `retry.onAuthFailure`: drops the cached token and asks for
   * one more attempt, so a request rejected with a stale token is retried once
   * with a freshly minted one.
   */
  readonly onAuthFailure: () => Promise<boolean>;
  /** Drop the cached token so the next request mints a fresh one. */
  invalidate(): Promise<void>;
  /** The current token, minting one if needed. Rarely needed directly. */
  getToken(): Promise<StoredToken>;
}

const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

/**
 * Machine-to-machine authentication with the OAuth 2.1 client-credentials
 * grant, cached and refreshed automatically.
 *
 * ```ts
 * const auth = createClientCredentialsAuth({
 *   tokenUrl: "https://auth.example.com/oauth2/token",
 *   clientId: process.env.CLIENT_ID!,
 *   clientSecret: process.env.CLIENT_SECRET!,
 *   scope: ["invoices:read"],
 * });
 *
 * const api = new RestClient({
 *   baseUrl: "https://api.example.com",
 *   authProvider: auth.authProvider,
 *   retry: { onAuthFailure: auth.onAuthFailure },
 * });
 * ```
 *
 * There is no refresh token to speak of: the client-credentials grant does not
 * issue one (RFC 6749 §4.4.3, unchanged in OAuth 2.1), so refreshing means
 * asking for another token. That is what happens when the cached one nears
 * expiry, or when {@link ClientCredentialsAuth.invalidate} is called.
 */
export function createClientCredentialsAuth<Ctx = unknown>(
  config: ClientCredentialsConfig,
): ClientCredentialsAuth<Ctx> {
  if (!config.clientSecret && !config.clientAssertion) {
    throw new TypeError(
      "createClientCredentialsAuth needs either a clientSecret or a clientAssertion.",
    );
  }

  const store = config.store ?? memoryTokenStore();
  const skewMs = (config.expirySkewSeconds ?? 60) * 1000;
  const headerName = config.headerName ?? "Authorization";
  const cacheKey = buildCacheKey(config);

  // One in-flight request per key. Without this, a burst of calls on a cold
  // cache each mint their own token: N round trips, N tokens, and on servers
  // that invalidate the previous one, a race the last writer wins.
  let inFlight: Promise<StoredToken> | undefined;

  async function fetchToken(): Promise<StoredToken> {
    const token = await requestToken(config);
    await store.set(cacheKey, token);
    return token;
  }

  async function getToken(): Promise<StoredToken> {
    const cached = await store.get(cacheKey);
    if (cached && cached.expiresAt - skewMs > Date.now()) return cached;

    inFlight ??= fetchToken().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  }

  return {
    authProvider: async () => {
      const token = await getToken();
      const scheme = config.scheme ?? token.tokenType;
      return { [headerName]: `${scheme} ${token.accessToken}` };
    },

    onAuthFailure: async () => {
      await store.delete(cacheKey);
      return true;
    },

    async invalidate() {
      await store.delete(cacheKey);
    },

    getToken,
  };
}

/**
 * A cache key covering everything that changes which token you get back.
 *
 * One process can hold distinct tokens for distinct audiences and scopes
 * without the caller having to name them.
 */
function buildCacheKey(config: ClientCredentialsConfig): string {
  return JSON.stringify([
    config.tokenUrl,
    config.clientId,
    normaliseList(config.scope).join(" "),
    normaliseList(config.resource),
  ]);
}

function normaliseList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? [...value] : [value as string];
}

/** Exchange the client's credentials for an access token. */
async function requestToken(config: ClientCredentialsConfig): Promise<StoredToken> {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError(
      "No fetch implementation available for the token request. Pass one as the `fetch` option.",
    );
  }

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  const scope = normaliseList(config.scope);
  if (scope.length > 0) body.set("scope", scope.join(" "));
  // RFC 8707: a resource indicator repeats rather than being joined.
  for (const resource of normaliseList(config.resource)) body.append("resource", resource);

  const { clientAssertion, clientSecret } = config;

  if (clientAssertion) {
    body.set("client_id", config.clientId);
    body.set("client_assertion_type", ASSERTION_TYPE);
    body.set("client_assertion", await clientAssertion());
  } else if (clientSecret === undefined) {
    // Unreachable via createClientCredentialsAuth, which rejects this
    // combination up front. Stated rather than asserted away, so a future
    // caller reaching requestToken directly gets an explanation.
    throw new TypeError("A client secret or a client assertion is required.");
  } else if ((config.authMethod ?? "client_secret_basic") === "client_secret_basic") {
    headers["Authorization"] = `Basic ${basicCredentials(config.clientId, clientSecret)}`;
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", clientSecret);
  }

  // Composed by hand rather than with AbortSignal.timeout, which is missing
  // from some React Native runtimes.
  const controller = new AbortController();
  const timer =
    config.timeoutMs !== undefined && config.timeoutMs > 0
      ? setTimeout(() => controller.abort(), config.timeoutMs)
      : undefined;

  let response: Response;
  try {
    response = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (cause) {
    const timedOut = controller.signal.aborted;
    throw new OAuthError({
      error: timedOut ? "timeout" : "network_error",
      errorDescription: timedOut
        ? `the token request exceeded ${String(config.timeoutMs)}ms`
        : cause instanceof Error
          ? cause.message
          : String(cause),
      status: 0,
      tokenUrl: config.tokenUrl,
      cause,
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  const payload = await readJson(response, config.tokenUrl);

  if (!response.ok) {
    throw new OAuthError({
      error: stringField(payload, "error") ?? `http_${response.status}`,
      ...(stringField(payload, "error_description") !== undefined && {
        errorDescription: stringField(payload, "error_description")!,
      }),
      ...(stringField(payload, "error_uri") !== undefined && {
        errorUri: stringField(payload, "error_uri")!,
      }),
      status: response.status,
      tokenUrl: config.tokenUrl,
    });
  }

  const accessToken = stringField(payload, "access_token");
  if (!accessToken) {
    throw new OAuthError({
      error: "invalid_response",
      errorDescription: "the token response carried no access_token",
      status: response.status,
      tokenUrl: config.tokenUrl,
    });
  }

  const expiresIn = numberField(payload, "expires_in");
  const grantedScope = stringField(payload, "scope");

  return {
    accessToken,
    tokenType: stringField(payload, "token_type") ?? "Bearer",
    // A server that omits expires_in has told us nothing; a conservative
    // default beats caching indefinitely and being rejected later.
    expiresAt: Date.now() + (expiresIn ?? 300) * 1000,
    ...(grantedScope !== undefined && { scope: grantedScope }),
  };
}

/** Parse a token response, reporting an unusable body as an OAuth failure. */
async function readJson(response: Response, tokenUrl: string): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new OAuthError({
      error: "invalid_response",
      errorDescription: `the token endpoint returned a body that is not JSON (${response.status})`,
      status: response.status,
      tokenUrl,
      cause,
    });
  }
}

function stringField(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(payload: unknown, key: string): number | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Some servers send expires_in as a string.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/**
 * The `Basic` credentials for a token request.
 *
 * RFC 6749 §2.3.1 requires the id and secret to be form-encoded before being
 * base64'd — a no-op for the alphanumeric credentials most servers issue, and
 * the difference between working and not for one containing a colon or a
 * non-ASCII character.
 */
function basicCredentials(clientId: string, clientSecret: string): string {
  const encoded = `${formEncode(clientId)}:${formEncode(clientSecret)}`;
  return base64(new TextEncoder().encode(encoded));
}

/**
 * The `application/x-www-form-urlencoded` serialisation of a single value.
 *
 * Not `encodeURIComponent`, which leaves `!`, `'`, `(`, `)`, and `~` alone
 * where form encoding percent-encodes them — a secret containing any of those
 * would otherwise be sent wrong. URLSearchParams implements the exact algorithm
 * the spec points at, so the platform does it rather than a hand-rolled table.
 */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice("v=".length);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 for a byte array.
 *
 * Written out rather than reached for: `btoa` is absent from some React Native
 * runtimes and mangles anything outside Latin-1, and `Buffer` does not exist in
 * a browser. This is a few lines and works everywhere.
 */
function base64(bytes: Uint8Array): string {
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];

    out += BASE64_ALPHABET[a >> 2];
    out += BASE64_ALPHABET[((a & 0b11) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : BASE64_ALPHABET[((b & 0b1111) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : BASE64_ALPHABET[c & 0b111111];
  }

  return out;
}
