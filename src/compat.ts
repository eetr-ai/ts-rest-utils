import { RestClient, type RestClientOptions, type RequestOptions } from "./client.js";
import type { ApiResponse } from "./response.js";

/**
 * A module-level client for the common case: one backend, configured once at
 * start-up, called from anywhere.
 *
 * The verb helpers below read the same as the hand-written `getApi`/`postApi`
 * wrappers most projects grow, so adopting the library can be an import change
 * rather than a rewrite. Prefer constructing a {@link RestClient} directly when
 * you have more than one backend, or in tests — shared mutable configuration is
 * exactly as awkward here as it is anywhere else.
 */
let defaultClient = new RestClient();

/**
 * Replace the default client's configuration.
 *
 * Deliberately not generic over a request context: storing a
 * `RestClient<Ctx>` in a module-level slot typed `RestClient<unknown>` needs an
 * unsound cast, and the helpers below never pass a context anyway. Construct a
 * {@link RestClient} directly when you want a typed one.
 */
export function configure(options: RestClientOptions): RestClient {
  defaultClient = new RestClient(options);
  return defaultClient;
}

/** The client the module-level helpers use. */
export function getDefaultClient(): RestClient {
  return defaultClient;
}

/** Reset the default client to an unconfigured one. Mostly useful in tests. */
export function resetDefaultClient(): void {
  defaultClient = new RestClient();
}

type BodylessOptions = Omit<RequestOptions, "method" | "body">;

/** `GET` through the default client. */
export function getApi<T = unknown>(
  url: string,
  options?: BodylessOptions,
): Promise<ApiResponse<T>> {
  return defaultClient.get<T>(url, options);
}

/** `POST` through the default client. */
export function postApi<T = unknown>(
  url: string,
  body?: unknown,
  options?: BodylessOptions,
): Promise<ApiResponse<T>> {
  return defaultClient.post<T>(url, body, options);
}

/** `PUT` through the default client. */
export function putApi<T = unknown>(
  url: string,
  body?: unknown,
  options?: BodylessOptions,
): Promise<ApiResponse<T>> {
  return defaultClient.put<T>(url, body, options);
}

/** `PATCH` through the default client. */
export function patchApi<T = unknown>(
  url: string,
  body?: unknown,
  options?: BodylessOptions,
): Promise<ApiResponse<T>> {
  return defaultClient.patch<T>(url, body, options);
}

/** `DELETE` through the default client. */
export function deleteApi<T = unknown>(
  url: string,
  body?: unknown,
  options?: BodylessOptions,
): Promise<ApiResponse<T>> {
  return defaultClient.delete<T>(url, body, options);
}
