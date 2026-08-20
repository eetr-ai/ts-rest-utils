/**
 * OAuth 2.1 client-credentials support for `@eetr/ts-rest-utils`.
 *
 * A separate entry point so the core stays small for callers who do not need
 * it. Still no runtime dependencies: signing a `private_key_jwt` assertion is
 * the caller's to do, and everything else is `fetch` and `URLSearchParams`.
 *
 * ```ts
 * import { RestClient } from "@eetr/ts-rest-utils";
 * import { createClientCredentialsAuth } from "@eetr/ts-rest-utils/oauth";
 * ```
 */

export {
  createClientCredentialsAuth,
  type ClientAuthMethod,
  type ClientCredentialsAuth,
  type ClientCredentialsConfig,
} from "./client-credentials.js";

export { OAuthError } from "./errors.js";

export { memoryTokenStore, type StoredToken, type TokenStore } from "./store.js";
