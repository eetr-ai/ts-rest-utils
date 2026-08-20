/** What a retry decision gets to look at. */
export interface RetryContext {
  /** 1 for the first attempt. */
  attempt: number;
  /** The response, when one arrived. Absent if the request threw. */
  response?: Response;
  /** The error, when the request threw rather than answering. */
  error?: unknown;
  url: string;
  method: string;
}

/** Everything a re-authentication hook needs to decide what to do. */
export interface AuthFailureContext extends RetryContext {
  response: Response;
}

/** How a request should be retried. */
export interface RetryOptions {
  /**
   * Total attempts, including the first. `1` disables retrying.
   *
   * @default 1, or 2 when {@link onAuthFailure} is set — a refresh hook that
   * never got a second attempt to use the new credential would be inert, and
   * silently so.
   */
  attempts?: number;

  /**
   * Base delay between attempts, in milliseconds.
   * @default 300
   */
  delayMs?: number;

  /**
   * How the delay grows. `exponential` doubles each time.
   * @default "exponential"
   */
  backoff?: "fixed" | "exponential";

  /**
   * Upper bound on a single delay, in milliseconds.
   * @default 10_000
   */
  maxDelayMs?: number;

  /**
   * Statuses worth retrying, or a predicate for full control.
   * @default [408, 429, 500, 502, 503, 504]
   */
  retryOn?: readonly number[] | ((context: RetryContext) => boolean | Promise<boolean>);

  /**
   * Whether a thrown request (network failure) should be retried.
   * A caller-cancelled request is never retried regardless.
   * @default true
   */
  retryOnNetworkError?: boolean;

  /**
   * Called when a response says the credentials were rejected, before any
   * retry. Return `true` to retry with freshly-built headers, `false` to give
   * up and hand the response back.
   *
   * This is the general form of the refresh-and-retry loop that mobile clients
   * grow around expiring tokens: the library re-runs the auth provider, it does
   * not know or care what a credential is.
   */
  onAuthFailure?: (context: AuthFailureContext) => boolean | Promise<boolean>;

  /**
   * Statuses that trigger {@link onAuthFailure}.
   * @default [401]
   */
  authFailureStatuses?: readonly number[];

  /**
   * Honour a `Retry-After` header when the server sends one.
   * @default true
   */
  respectRetryAfter?: boolean;
}

/** A retry policy with every default filled in. */
export interface ResolvedRetryPolicy {
  attempts: number;
  delayMs: number;
  backoff: "fixed" | "exponential";
  maxDelayMs: number;
  retryOn: (context: RetryContext) => boolean | Promise<boolean>;
  retryOnNetworkError: boolean;
  onAuthFailure: ((context: AuthFailureContext) => boolean | Promise<boolean>) | undefined;
  authFailureStatuses: readonly number[];
  respectRetryAfter: boolean;
}

const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 429, 500, 502, 503, 504];

/** Fill in the defaults for a partially-specified policy. */
export function resolveRetryPolicy(options?: RetryOptions): ResolvedRetryPolicy {
  const retryOn = options?.retryOn ?? DEFAULT_RETRY_STATUSES;

  return {
    attempts: Math.max(1, options?.attempts ?? (options?.onAuthFailure ? 2 : 1)),
    delayMs: options?.delayMs ?? 300,
    backoff: options?.backoff ?? "exponential",
    maxDelayMs: options?.maxDelayMs ?? 10_000,
    retryOn:
      typeof retryOn === "function"
        ? retryOn
        : (context) => context.response !== undefined && retryOn.includes(context.response.status),
    retryOnNetworkError: options?.retryOnNetworkError ?? true,
    onAuthFailure: options?.onAuthFailure,
    authFailureStatuses: options?.authFailureStatuses ?? [401],
    respectRetryAfter: options?.respectRetryAfter ?? true,
  };
}

/** The delay before `attempt`, in milliseconds. */
export function delayForAttempt(policy: ResolvedRetryPolicy, attempt: number): number {
  const growth = policy.backoff === "exponential" ? 2 ** (attempt - 1) : 1;
  return Math.min(policy.delayMs * growth, policy.maxDelayMs);
}

/**
 * The server's requested wait from a `Retry-After` header, in milliseconds.
 *
 * The header comes in two forms: a number of seconds, or an HTTP date. Returns
 * `undefined` when absent or unparseable, and never returns a negative wait for
 * a date already in the past.
 */
export function retryAfterMs(response: Response | undefined): number | undefined {
  const header = response?.headers.get("Retry-After");
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}

/** Resolve after `ms`, rejecting early if `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
