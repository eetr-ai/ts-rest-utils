/**
 * `@eetr/ts-rest-utils` — a small, dependency-free REST client for TypeScript.
 *
 * The public surface (`RestClient`, `ApiResponse`, and the URL/body helpers)
 * lands in the change that follows this one; for now the entry point carries
 * only the method type they are all built around.
 */

/** An HTTP method the client can issue. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
