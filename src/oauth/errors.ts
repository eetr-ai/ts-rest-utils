/**
 * A token endpoint refused the request.
 *
 * RFC 6749 §5.2 defines the shape: a machine-readable `error` code such as
 * `invalid_client`, optionally with a human-readable `error_description`. Both
 * are surfaced, since the code is what you branch on and the description is
 * what tells you which of six things went wrong.
 */
export class OAuthError extends Error {
  /** The RFC 6749 error code, or `invalid_response` if the body was unusable. */
  readonly error: string;
  readonly errorDescription: string | undefined;
  readonly errorUri: string | undefined;
  /** HTTP status of the token response. */
  readonly status: number;
  readonly tokenUrl: string;

  constructor(params: {
    error: string;
    errorDescription?: string;
    errorUri?: string;
    status: number;
    tokenUrl: string;
    cause?: unknown;
  }) {
    const detail = params.errorDescription ? `: ${params.errorDescription}` : "";
    super(`Token request to ${params.tokenUrl} failed with ${params.error}${detail}`, {
      cause: params.cause,
    });
    this.name = "OAuthError";
    this.error = params.error;
    this.errorDescription = params.errorDescription;
    this.errorUri = params.errorUri;
    this.status = params.status;
    this.tokenUrl = params.tokenUrl;
  }
}
