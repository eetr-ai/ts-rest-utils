/**
 * `@eetr/ts-rest-utils` — a small, dependency-free REST client for TypeScript.
 *
 * ```ts
 * import { RestClient } from "@eetr/ts-rest-utils";
 *
 * const api = new RestClient({ baseUrl: "https://api.example.com" });
 * const user = (await api.get<User>("/users/me")).getOrThrow();
 * ```
 *
 * The client knows nothing about any particular API. Credentials arrive through
 * the `authProvider` hook, base URLs and retry and logging are options, and the
 * package has no runtime dependencies — so the same code runs in Node, in a
 * browser, and in React Native.
 */

export {
  RestClient,
  type AuthContext,
  type AuthProvider,
  type HeaderSource,
  type HttpMethod,
  type RequestOptions,
  type RestClientOptions,
} from "./client.js";

export { APIResponse, ApiResponse, type ApiResponseInit } from "./response.js";

export {
  HttpError,
  NetworkError,
  RestError,
  TimeoutError,
  type RestErrorContext,
} from "./errors.js";

export {
  buildUrl,
  createEndpoints,
  resolveBase,
  withQuery,
  type QueryParams,
  type QueryValue,
} from "./url.js";

export { decodeBody, encodeBody, type DecodeMode, type EncodedBody } from "./body.js";

export { type AuthFailureContext, type RetryContext, type RetryOptions } from "./retry.js";

export {
  consoleLogger,
  noopLogger,
  redactHeaders,
  redactUrl,
  type ErrorLogEvent,
  type Logger,
  type RequestLogEvent,
  type ResponseLogEvent,
} from "./logger.js";

export {
  configure,
  deleteApi,
  getApi,
  getDefaultClient,
  patchApi,
  postApi,
  putApi,
  resetDefaultClient,
} from "./compat.js";
