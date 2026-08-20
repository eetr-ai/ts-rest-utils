/** A token held on behalf of one client and audience. */
export interface StoredToken {
  accessToken: string;
  /** Usually `Bearer`. Preserved as the server sent it. */
  tokenType: string;
  /** Epoch milliseconds at which the token stops being valid. */
  expiresAt: number;
  /** The scope the server actually granted, which may narrow what was asked. */
  scope?: string;
}

/**
 * Where minted tokens are kept.
 *
 * Deliberately three methods and nothing more, so backing it with Redis, a
 * worker KV namespace, React Native's secure storage, or a database row is a
 * few lines rather than an integration. Every method may be synchronous or
 * asynchronous.
 */
export interface TokenStore {
  get(key: string): Promise<StoredToken | undefined> | StoredToken | undefined;
  set(key: string, token: StoredToken): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/**
 * An in-process store, and the default.
 *
 * Fine for a single long-lived process. Across several — serverless instances,
 * a pod that scales — each holds its own copy and mints its own token, which is
 * usually acceptable and occasionally not. Supply a shared store when it is not.
 */
export function memoryTokenStore(): TokenStore {
  const tokens = new Map<string, StoredToken>();

  return {
    get: (key) => tokens.get(key),
    set: (key, token) => {
      tokens.set(key, token);
    },
    delete: (key) => {
      tokens.delete(key);
    },
  };
}
