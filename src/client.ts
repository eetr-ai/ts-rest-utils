import { type DecodeMode, contentTypeOf, decodeBody, encodeBody } from "./body.js";
import { NetworkError, TimeoutError } from "./errors.js";
import { type Logger, noopLogger } from "./logger.js";
import { ApiResponse } from "./response.js";
import {
  type ResolvedRetryPolicy,
  type RetryOptions,
  delayForAttempt,
  resolveRetryPolicy,
  retryAfterMs,
  sleep,
} from "./retry.js";
import { type QueryParams, buildUrl, withQuery } from "./url.js";

/** An HTTP method the client can issue. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** What an auth provider is told about the request it is signing. */
export interface AuthContext<Ctx> {
  /** The fully-resolved URL, query string included. */
  url: string;
  method: string;
  /** The named service this request was routed to, when one was used. */
  service: string | undefined;
  /**
   * Whether the body is multipart. Some schemes sign the content type, and it
   * is the one case where the library deliberately leaves that header unset.
   */
  isFormData: boolean;
  /** Whatever per-request value the caller attached. Never inspected here. */
  context: Ctx | undefined;
  /** Which attempt this is; `2` and above follow a retry. */
  attempt: number;
}

/**
 * Produces the credential headers for a request.
 *
 * This is the single seam for authentication. The library ships no credential
 * logic of its own — bearer tokens, API keys, cloud identity tokens and OAuth
 * flows are all just implementations of this function, which is what keeps the
 * package dependency-free and usable in a browser, in Node, and in React
 * Native without change.
 *
 * It is called once per attempt, so a provider that refreshes an expired token
 * takes effect on the retry.
 */
export type AuthProvider<Ctx> = (
  context: AuthContext<Ctx>,
) => HeadersInit | undefined | Promise<HeadersInit | undefined>;

/** Static headers, or a function producing them per request. */
export type HeaderSource =
  | HeadersInit
  | (() => HeadersInit | undefined | Promise<HeadersInit | undefined>);

/** How a {@link RestClient} behaves. */
export interface RestClientOptions<Ctx = unknown> {
  /** Prefix for relative paths. */
  baseUrl?: string;

  /**
   * Named base URLs, for an app talking to more than one backend.
   * Reach them with `client.path("name", "/some/path")` or `{ service }`.
   */
  services?: Readonly<Record<string, string>>;

  /** Headers applied to every request. */
  headers?: HeaderSource;

  /** Supplies credential headers. See {@link AuthProvider}. */
  authProvider?: AuthProvider<Ctx>;

  /** A default per-request context handed to {@link AuthProvider}. */
  context?: Ctx;

  /**
   * The `fetch` implementation to use.
   * @default globalThis.fetch
   */
  fetch?: typeof fetch;

  /**
   * Abort an attempt that takes longer than this, in milliseconds.
   *
   * Applies per attempt, not to the request as a whole: with retries enabled,
   * the total time can reach roughly `attempts * timeoutMs` plus the backoff
   * waits. Pass your own `signal` when you need a deadline across all of them.
   */
  timeoutMs?: number;

  /** Retry policy. Retries are off unless configured. */
  retry?: RetryOptions;

  /** Where to report requests and responses. Silent by default. */
  logger?: Logger;

  /**
   * Extra `RequestInit` merged into every request.
   *
   * The escape hatch for runtime-specific options the standard type does not
   * cover — for instance Next.js's `next: { revalidate }`, or `cache` and
   * `credentials` defaults.
   */
  defaultInit?: RequestInit;

  /**
   * How to decode response bodies.
   * @default "auto"
   */
  decode?: DecodeMode;
}

/** Per-request options. */
export interface RequestOptions<Ctx = unknown> {
  method?: HttpMethod;
  /** Serialised as JSON unless it is a type the platform sends natively. */
  body?: unknown;
  /** Appended to the URL as a query string. */
  query?: QueryParams;
  headers?: HeadersInit;
  /** Route through one of the configured `services`. */
  service?: string;
  /** Value passed to the auth provider for this request only. */
  context?: Ctx;
  signal?: AbortSignal;
  timeoutMs?: number;
  decode?: DecodeMode;
  /** Replaces the client's policy for this request; the two are not merged. */
  retry?: RetryOptions;
  /** Extra `RequestInit` for this request, merged over `defaultInit`. */
  init?: RequestInit;
}

/**
 * The result of composing a caller's signal with a timeout, without relying on
 * `AbortSignal.any` or `AbortSignal.timeout`.
 *
 * Both are missing from some React Native runtimes, and a client that throws
 * `AbortSignal.any is not a function` on a phone is worse than one that spends
 * a few lines doing it by hand.
 */
interface ComposedSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

function composeSignal(
  timeoutMs: number | undefined,
  external: AbortSignal | undefined,
): ComposedSignal {
  const controller = new AbortController();
  let didTimeout = false;

  const onExternalAbort = () => {
    controller.abort(external?.reason);
  };

  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }

  const timer =
    timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          didTimeout = true;
          controller.abort();
        }, timeoutMs)
      : undefined;

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

/**
 * Reject as soon as `signal` aborts, however long the promise takes.
 *
 * The hooks a caller supplies — an auth provider minting a token, a refresh
 * callback — are ordinary promises, and there is no way to cancel arbitrary
 * user code. What this does is stop *waiting* on one: the request fails on its
 * deadline instead of hanging behind a hook that never settles. The hook itself
 * runs on to completion, unobserved.
 */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason as Error;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Resolve a possibly-callable header source. */
async function resolveHeaderSource(
  source: HeaderSource | undefined,
): Promise<HeadersInit | undefined> {
  if (source === undefined) return undefined;
  return typeof source === "function" ? source() : source;
}

/** Copy `from` over `into`, replacing rather than appending. */
function applyHeaders(into: Headers, from: HeadersInit | undefined): void {
  if (!from) return;
  new Headers(from).forEach((value, name) => {
    into.set(name, value);
  });
}

/**
 * A configurable REST client over the platform `fetch`.
 *
 * Every part that tends to differ between applications — base URLs,
 * credentials, retry policy, logging, body decoding — is an option, and the
 * client itself knows nothing about any particular API.
 *
 * ```ts
 * const api = new RestClient({ baseUrl: "https://api.example.com" });
 * const user = (await api.get<User>("/users/me")).getOrThrow();
 * ```
 */
export class RestClient<Ctx = unknown> {
  private readonly options: RestClientOptions<Ctx>;

  constructor(options: RestClientOptions<Ctx> = {}) {
    this.options = options;
  }

  /**
   * Build a URL against one of the configured `services`.
   * @throws {Error} when the service is not configured.
   */
  path(service: string, path: string): string {
    const base = this.options.services?.[service];
    if (base === undefined) {
      const known = Object.keys(this.options.services ?? {});
      throw new Error(
        `Unknown service ${JSON.stringify(service)}.` +
          (known.length > 0
            ? ` Configured services: ${known.join(", ")}.`
            : " No services are configured."),
      );
    }
    return buildUrl(path, base);
  }

  /**
   * A new client with `overrides` applied on top of this one's options.
   *
   * How per-request state attaches without threading an extra argument through
   * every call: derive a child carrying the context, and use it for the work
   * that shares that context.
   *
   * ```ts
   * const forUser = api.with({ context: { userId } });
   * await forUser.get("/preferences");
   * ```
   */
  with(overrides: RestClientOptions<Ctx>): RestClient<Ctx> {
    const parentHeaders = this.options.headers;
    const childHeaders = overrides.headers;

    const headers: HeaderSource | undefined =
      parentHeaders === undefined
        ? childHeaders
        : childHeaders === undefined
          ? parentHeaders
          : async () => {
              const merged = new Headers();
              applyHeaders(merged, await resolveHeaderSource(parentHeaders));
              applyHeaders(merged, await resolveHeaderSource(childHeaders));
              return merged;
            };

    return new RestClient<Ctx>({
      ...this.options,
      ...overrides,
      ...(headers === undefined ? {} : { headers }),
      services: { ...this.options.services, ...overrides.services },
      defaultInit: { ...this.options.defaultInit, ...overrides.defaultInit },
    });
  }

  /** Issue a request and return the decoded response. */
  async request<T = unknown>(
    path: string,
    options: RequestOptions<Ctx> = {},
  ): Promise<ApiResponse<T>> {
    const method = (options.method ?? "GET").toUpperCase() as HttpMethod;
    const url = withQuery(this.resolveUrl(path, options.service), options.query);

    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new Error(
        "No fetch implementation available. Pass one as the `fetch` option, or run on a platform that provides a global fetch.",
      );
    }

    const logger: Logger = this.options.logger ?? noopLogger;
    const policy = resolveRetryPolicy(options.retry ?? this.options.retry);
    const decode = options.decode ?? this.options.decode ?? "auto";
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
    const context = options.context ?? this.options.context;

    // A caller can pass a signal three ways, and the composed one is assigned
    // last when the request is built — so any signal left on a RequestInit
    // would be quietly overwritten and their cancellation would do nothing.
    const callerSignal =
      options.signal ?? options.init?.signal ?? this.options.defaultInit?.signal ?? undefined;

    // Encoded once: re-encoding per attempt would re-stringify needlessly, and
    // a body the platform sends natively (FormData, a Blob) is reusable as-is.
    // A ReadableStream body is the exception — it cannot be replayed, so a
    // retry of one will fail. That is a property of streams, not of the policy.
    const encoded = encodeBody(options.body);
    const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;

    let lastError: unknown;

    /* oxlint-disable no-await-in-loop -- Retrying is sequential by definition:
       every attempt depends on how the previous one turned out, and the delay
       between them is the point. Running these concurrently, as the rule
       suggests, would issue all the attempts at once. */

    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      // Composed first, so building the headers is inside the deadline too.
      // An auth provider is the most likely thing in a request to make its own
      // network call, and a timeout that started after it would not cover the
      // one part most able to hang.
      const composed = composeSignal(timeoutMs, callerSignal ?? undefined);
      const startedAt = Date.now();

      let headers: Headers;
      try {
        headers = await untilAborted(
          this.buildHeaders({
            url,
            method,
            service: options.service,
            isFormData,
            context,
            attempt,
            contentType: encoded.contentType,
            initHeaders: options.init?.headers,
            perCall: options.headers,
          }),
          composed.signal,
        );
      } catch (error) {
        composed.cleanup();
        if (callerSignal?.aborted) {
          throw new NetworkError({ url, method, cause: callerSignal.reason });
        }
        if (composed.timedOut()) {
          throw new TimeoutError({ url, method, timeoutMs: timeoutMs ?? 0, cause: error });
        }
        throw error;
      }

      logger.request?.({ method, url, headers, attempt });

      // `body` is assigned only when there is one: under
      // exactOptionalPropertyTypes, RequestInit.body is `BodyInit | null`, so
      // passing an explicit `undefined` is a type error rather than an omission.
      const init: RequestInit = {
        ...this.options.defaultInit,
        ...options.init,
        method,
        headers,
        signal: composed.signal,
      };
      if (encoded.body !== undefined) init.body = encoded.body;

      let response: Response;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const timedOut = composed.timedOut();
        composed.cleanup();

        logger.error?.({ method, url, headers, attempt, error, durationMs });

        // A caller who aborted deliberately gets their own reason back, and is
        // never retried — they asked for this to stop.
        if (callerSignal?.aborted) {
          throw new NetworkError({ url, method, cause: callerSignal.reason });
        }
        if (timedOut) {
          throw new TimeoutError({ url, method, timeoutMs: timeoutMs ?? 0, cause: error });
        }

        lastError = error;
        const canRetry = attempt < policy.attempts && policy.retryOnNetworkError;
        if (!canRetry) throw new NetworkError({ url, method, cause: error });

        const delay = delayForAttempt(policy, attempt);
        logger.retry?.({ method, url, headers, attempt, error, durationMs }, delay);
        await waitBeforeRetry(delay, callerSignal ?? undefined, url, method);
        continue;
      }

      const durationMs = Date.now() - startedAt;
      logger.response?.({ method, url, headers, attempt, status: response.status, durationMs });

      const retryContext = { attempt, response, url, method };
      const isLastAttempt = attempt >= policy.attempts;

      /**
       * Ask a retry hook, but never outlive the deadline doing it. A decision
       * that arrives after the attempt has already timed out must not be
       * allowed to start another one.
       */
      const ask = async (decide: () => Promise<boolean> | boolean): Promise<boolean> => {
        try {
          // Invoked inside the try, not by the caller: a hook that throws
          // synchronously would otherwise escape before this ran, leaving the
          // response body unread and the abort listener attached.
          return await untilAborted(Promise.resolve(decide()), composed.signal);
        } catch (error) {
          composed.cleanup();
          await discard(response);
          if (callerSignal?.aborted) {
            throw new NetworkError({ url, method, cause: callerSignal.reason });
          }
          if (composed.timedOut()) {
            throw new TimeoutError({ url, method, timeoutMs: timeoutMs ?? 0, cause: error });
          }
          throw error;
        }
      };

      // A rejected credential is worth one more try only if something is going
      // to change in between — that is what the hook is for. Captured to a
      // local so the closure below needs no non-null assertion.
      const onAuthFailure = policy.onAuthFailure;
      if (
        !isLastAttempt &&
        onAuthFailure !== undefined &&
        policy.authFailureStatuses.includes(response.status) &&
        (await ask(() => onAuthFailure({ ...retryContext, response })))
      ) {
        composed.cleanup();
        await discard(response);
        logger.retry?.({ method, url, headers, attempt, status: response.status, durationMs }, 0);
        continue;
      }

      if (!isLastAttempt && (await ask(() => policy.retryOn(retryContext)))) {
        const delay = retryDelay(policy, response, attempt);
        composed.cleanup();
        await discard(response);
        logger.retry?.(
          { method, url, headers, attempt, status: response.status, durationMs },
          delay,
        );
        await waitBeforeRetry(delay, callerSignal ?? undefined, url, method);
        continue;
      }

      // Decoding stays inside the deadline. The response arriving only means
      // the headers arrived; a body that stalls mid-stream would otherwise hang
      // for as long as the connection stayed open, with the timeout already
      // disarmed. Aborting the signal cancels the body stream too.
      try {
        const body = await decodeBody<T>(response, decode, method);
        return new ApiResponse<T>({
          status: response.status,
          bodyType: contentTypeOf(response),
          body,
          headers: response.headers,
          raw: response,
          url,
          method,
        });
      } catch (error) {
        if (callerSignal?.aborted) {
          throw new NetworkError({ url, method, cause: callerSignal.reason });
        }
        if (composed.timedOut()) {
          throw new TimeoutError({ url, method, timeoutMs: timeoutMs ?? 0, cause: error });
        }
        // A genuine decoding failure — malformed JSON from a server that said
        // it was sending JSON. Surfaced as-is rather than dressed up.
        throw error;
      } finally {
        composed.cleanup();
      }
    }

    /* oxlint-enable no-await-in-loop */

    // Unreachable: the loop either returns or throws. Kept so the compiler can
    // see a terminal case, and so a future edit to the loop fails loudly.
    throw new NetworkError({ url, method, cause: lastError });
  }

  /** Resolve a path to a full URL. */
  resolveUrl(path: string, service?: string): string {
    if (service !== undefined) return this.path(service, path);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;

    const base = this.options.baseUrl;
    if (base === undefined) {
      throw new Error(
        `Cannot resolve ${JSON.stringify(path)}: the client has no baseUrl, the path is not absolute, and no service was named.`,
      );
    }
    return buildUrl(path, base);
  }

  /** Compose the headers for one attempt, in precedence order. */
  private async buildHeaders(input: {
    url: string;
    method: string;
    service: string | undefined;
    isFormData: boolean;
    context: Ctx | undefined;
    attempt: number;
    contentType: string | undefined;
    initHeaders: HeadersInit | undefined;
    perCall: HeadersInit | undefined;
  }): Promise<Headers> {
    const headers = new Headers();

    // Lowest precedence first, so each layer can override the one before it.
    // `init.headers` is merged here rather than left on the RequestInit: the
    // composed Headers object is assigned last when the request is built, so
    // anything still sitting on `init` would be silently discarded.
    applyHeaders(headers, this.options.defaultInit?.headers);
    applyHeaders(headers, input.initHeaders);
    if (input.contentType !== undefined) headers.set("Content-Type", input.contentType);
    applyHeaders(headers, await resolveHeaderSource(this.options.headers));

    if (this.options.authProvider) {
      applyHeaders(
        headers,
        await this.options.authProvider({
          url: input.url,
          method: input.method,
          service: input.service,
          isFormData: input.isFormData,
          context: input.context,
          attempt: input.attempt,
        }),
      );
    }

    applyHeaders(headers, input.perCall);
    return headers;
  }

  get<T = unknown>(path: string, options?: Omit<RequestOptions<Ctx>, "method" | "body">) {
    return this.request<T>(path, { ...options, method: "GET" });
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions<Ctx>, "method" | "body">,
  ) {
    return this.request<T>(path, { ...options, method: "POST", body });
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions<Ctx>, "method" | "body">,
  ) {
    return this.request<T>(path, { ...options, method: "PUT", body });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions<Ctx>, "method" | "body">,
  ) {
    return this.request<T>(path, { ...options, method: "PATCH", body });
  }

  delete<T = unknown>(
    path: string,
    body?: unknown,
    options?: Omit<RequestOptions<Ctx>, "method" | "body">,
  ) {
    return this.request<T>(path, { ...options, method: "DELETE", body });
  }

  head(path: string, options?: Omit<RequestOptions<Ctx>, "method" | "body">) {
    return this.request<undefined>(path, { ...options, method: "HEAD" });
  }

  /**
   * Whether an endpoint answers with a 2xx, without reading its body.
   *
   * For liveness checks and warm-up calls, where the payload is irrelevant and
   * a failure is an answer rather than an exception. Never throws.
   */
  async ok(path: string, options?: Omit<RequestOptions<Ctx>, "body" | "decode">): Promise<boolean> {
    try {
      const response = await this.request<undefined>(path, {
        ...options,
        method: options?.method ?? "GET",
        decode: "none",
      });
      await discard(response.raw);
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * How long to wait before the next attempt.
 *
 * A server's `Retry-After` is preferred when the policy allows it — it knows
 * when it will be ready and the client does not — but it is still clamped to
 * `maxDelayMs`. The header is a value from the far end of the connection, and
 * an unbounded one (a misconfiguration, or a `Retry-After: 86400`) would
 * otherwise park the caller for as long as it asked.
 */
function retryDelay(policy: ResolvedRetryPolicy, response: Response, attempt: number): number {
  const backoff = delayForAttempt(policy, attempt);
  if (!policy.respectRetryAfter) return backoff;

  const requested = retryAfterMs(response);
  if (requested === undefined) return backoff;

  return Math.min(requested, policy.maxDelayMs);
}

/**
 * Wait out a backoff delay, reporting a mid-wait cancellation the same way a
 * mid-request one is reported.
 *
 * Without this the raw abort reason escapes, so the error a caller sees for
 * "cancelled while waiting to retry" would not be a {@link RestError} while the
 * one for "cancelled during the request" would be.
 */
async function waitBeforeRetry(
  ms: number,
  signal: AbortSignal | undefined,
  url: string,
  method: string,
): Promise<void> {
  try {
    await sleep(ms, signal);
  } catch (cause) {
    throw new NetworkError({ url, method, cause });
  }
}

/**
 * Release a response body that will not be read.
 *
 * An unread body holds its connection open until the runtime gets around to
 * collecting it, which on a retry loop means leaking one socket per attempt.
 */
async function discard(response: Response | undefined): Promise<void> {
  try {
    await response?.body?.cancel();
  } catch {
    // Already closed or errored — nothing left to release.
  }
}
