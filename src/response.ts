import { HttpError } from "./errors.js";

/** Constructor arguments for {@link ApiResponse}. */
export interface ApiResponseInit<T> {
  status: number;
  bodyType: string;
  body: T;
  headers?: Headers;
  /** The originating `Response`, when this came from a real request. */
  raw?: Response;
  url?: string;
  method?: string;
}

/**
 * A response with its body already decoded, plus the small set of accessors
 * that let a caller state what an unsuccessful status should mean *at the call
 * site* rather than in a chain of `if (status !== 200)` blocks.
 *
 * The three accessors, the 2xx-or-explicit-status rule, and the constructor
 * shape are carried over unchanged from the hand-written clients this library
 * replaces, so existing call sites keep working.
 */
export class ApiResponse<T> {
  readonly status: number;
  readonly bodyType: string;
  readonly body: T;
  readonly headers: Headers;
  readonly raw: Response | undefined;
  readonly url: string;
  readonly method: string;

  constructor(params: ApiResponseInit<T>) {
    this.status = params.status;
    this.bodyType = params.bodyType;
    this.body = params.body;
    this.headers = params.headers ?? new Headers();
    this.raw = params.raw;
    this.url = params.url ?? params.raw?.url ?? "";
    this.method = params.method ?? "";
  }

  /** Whether the status is in the 2xx range. */
  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /**
   * The body when the request succeeded, otherwise `defaultValue`.
   *
   * Pass `successStatus` to require one exact status instead of the 2xx range —
   * useful for an endpoint where, say, only `201` means the thing was created.
   */
  getOrDefault(defaultValue: T, successStatus?: number): T {
    return this.isSuccess(successStatus) ? this.body : defaultValue;
  }

  /** The body when the request succeeded, otherwise `null`. */
  getOrNull(successStatus?: number): T | null {
    return this.isSuccess(successStatus) ? this.body : null;
  }

  /**
   * The body when the request succeeded, otherwise throw.
   *
   * With no argument this throws an {@link HttpError} carrying the status and
   * decoded body. Pass `throwable` to throw something of your own instead —
   * the behaviour the original clients had.
   */
  getOrThrow(throwable?: unknown, successStatus?: number): T {
    if (this.isSuccess(successStatus)) return this.body;

    if (throwable !== undefined) throw throwable;

    throw new HttpError(
      `${this.method || "request"} ${this.url || "(unknown url)"} returned ${this.status}`,
      {
        url: this.url,
        method: this.method,
        status: this.status,
        body: this.body,
      },
    );
  }

  /**
   * Whether this response counts as successful: the 2xx range by default, or
   * exactly `successStatus` when one is given.
   */
  isSuccess(successStatus?: number): boolean {
    return successStatus === undefined ? this.ok : this.status === successStatus;
  }
}

/**
 * Alias kept for codebases migrating off a hand-written client that spelled it
 * this way.
 */
export { ApiResponse as APIResponse };
