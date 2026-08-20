import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createClientCredentialsAuth } from "./client-credentials.js";
import { OAuthError } from "./errors.js";
import type { StoredToken, TokenStore } from "./store.js";

const TOKEN_URL = "https://auth.test/oauth2/token";

/** A token endpoint that records what it was asked. */
function tokenEndpoint(...responses: Array<() => Response>) {
  const requests: Array<{ headers: Headers; body: URLSearchParams }> = [];
  let index = 0;
  const impl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      headers: new Headers(init?.headers),
      body: new URLSearchParams(String(init?.body ?? "")),
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return next ? next() : granted();
  });
  return Object.assign(impl as unknown as typeof fetch, { requests });
}

function granted(overrides: Record<string, unknown> = {}) {
  return () =>
    new Response(
      JSON.stringify({
        access_token: "token-1",
        token_type: "Bearer",
        expires_in: 3600,
        ...overrides,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
}

function denied(status: number, body: unknown) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

const base = { tokenUrl: TOKEN_URL, clientId: "client-1", clientSecret: "s3cr3t" };

describe("configuration", () => {
  it("insists on a secret or an assertion", () => {
    expect(() => createClientCredentialsAuth({ tokenUrl: TOKEN_URL, clientId: "c" })).toThrow(
      TypeError,
    );
  });
});

describe("the token request", () => {
  it("uses the client_credentials grant", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({ ...base, fetch }).getToken();
    expect(fetch.requests[0]?.body.get("grant_type")).toBe("client_credentials");
  });

  it("sends the credentials as Basic auth by default", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({ ...base, fetch }).getToken();
    // OAuth 2.1 prefers client_secret_basic, so the secret must not be in the body.
    const header = fetch.requests[0]?.headers.get("Authorization");
    expect(header).toBe(`Basic ${btoa("client-1:s3cr3t")}`);
    expect(fetch.requests[0]?.body.get("client_secret")).toBeNull();
  });

  it("form-encodes the credentials before base64, as RFC 6749 requires", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({
      ...base,
      clientId: "id with space",
      clientSecret: "pa:ss/word",
      fetch,
    }).getToken();
    const header = fetch.requests[0]?.headers.get("Authorization") ?? "";
    const decoded = atob(header.replace("Basic ", ""));
    expect(decoded).toBe("id+with+space:pa%3Ass%2Fword");
  });

  it.each([
    ["tilde~", "tilde%7E"],
    ["bang!", "bang%21"],
    ["paren(s)", "paren%28s%29"],
    ["quote'x", "quote%27x"],
  ])("form-encodes %j strictly, not as encodeURIComponent would", async (secret, expected) => {
    // encodeURIComponent leaves these five characters alone; the
    // application/x-www-form-urlencoded algorithm the spec points at does not.
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({ ...base, clientSecret: secret, fetch }).getToken();
    const header = fetch.requests[0]?.headers.get("Authorization") ?? "";
    expect(atob(header.replace("Basic ", ""))).toBe(`client-1:${expected}`);
  });

  it("puts the credentials in the body when asked to", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({
      ...base,
      authMethod: "client_secret_post",
      fetch,
    }).getToken();
    expect(fetch.requests[0]?.headers.get("Authorization")).toBeNull();
    expect(fetch.requests[0]?.body.get("client_id")).toBe("client-1");
    expect(fetch.requests[0]?.body.get("client_secret")).toBe("s3cr3t");
  });

  it("sends a client assertion in place of a secret", async () => {
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({
      tokenUrl: TOKEN_URL,
      clientId: "client-1",
      clientAssertion: async () => "signed.jwt.value",
      fetch,
    });
    await auth.getToken();
    const body = fetch.requests[0]?.body;
    expect(body?.get("client_assertion")).toBe("signed.jwt.value");
    expect(body?.get("client_assertion_type")).toBe(
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    );
    expect(fetch.requests[0]?.headers.get("Authorization")).toBeNull();
  });

  it("joins a scope array with spaces", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({ ...base, scope: ["a:read", "b:write"], fetch }).getToken();
    expect(fetch.requests[0]?.body.get("scope")).toBe("a:read b:write");
  });

  it("repeats a resource indicator per value, as RFC 8707 requires", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({
      ...base,
      resource: ["https://a.test", "https://b.test"],
      fetch,
    }).getToken();
    expect(fetch.requests[0]?.body.getAll("resource")).toEqual([
      "https://a.test",
      "https://b.test",
    ]);
  });

  it("omits scope and resource when not configured", async () => {
    const fetch = tokenEndpoint(granted());
    await createClientCredentialsAuth({ ...base, fetch }).getToken();
    expect(fetch.requests[0]?.body.get("scope")).toBeNull();
    expect(fetch.requests[0]?.body.getAll("resource")).toEqual([]);
  });
});

describe("caching", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("mints once and reuses until expiry", async () => {
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await auth.getToken();
    await auth.getToken();
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-mints once the skew window is reached", async () => {
    const fetch = tokenEndpoint(granted({ expires_in: 100 }));
    const auth = createClientCredentialsAuth({ ...base, expirySkewSeconds: 30, fetch });
    await auth.getToken();

    vi.advanceTimersByTime(69_000); // still outside the window
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000); // now inside it
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("mints once for a burst of concurrent callers", async () => {
    // Without single-flight this is N round trips and N tokens, and on a server
    // that invalidates the previous one, a race the last writer wins.
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await Promise.all(Array.from({ length: 25 }, () => auth.getToken()));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("mints again after a failed burst rather than caching the failure", async () => {
    const fetch = tokenEndpoint(denied(500, { error: "server_error" }), granted());
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await expect(auth.getToken()).rejects.toBeInstanceOf(OAuthError);
    await expect(auth.getToken()).resolves.toMatchObject({ accessToken: "token-1" });
  });

  it("drops the cached token on invalidate()", async () => {
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await auth.getToken();
    await auth.invalidate();
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps separate tokens for separate scopes", async () => {
    const fetch = tokenEndpoint(granted());
    const store = trackingStore();
    const a = createClientCredentialsAuth({ ...base, scope: "a", store, fetch });
    const b = createClientCredentialsAuth({ ...base, scope: "b", store, fetch });
    await a.getToken();
    await b.getToken();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(store.keys().length).toBe(2);
  });
});

function trackingStore(): TokenStore & { keys(): string[] } {
  const map = new Map<string, StoredToken>();
  return {
    get: (k) => map.get(k),
    set: (k, v) => void map.set(k, v),
    delete: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

describe("the token store", () => {
  it("is used for get, set, and delete", async () => {
    const store = trackingStore();
    const get = vi.spyOn(store, "get");
    const set = vi.spyOn(store, "set");
    const del = vi.spyOn(store, "delete");

    const auth = createClientCredentialsAuth({ ...base, store, fetch: tokenEndpoint(granted()) });
    await auth.getToken();
    await auth.invalidate();

    expect(get).toHaveBeenCalled();
    expect(set).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
  });

  it("accepts an asynchronous implementation", async () => {
    const map = new Map<string, StoredToken>();
    const store: TokenStore = {
      get: async (k) => map.get(k),
      set: async (k, v) => void map.set(k, v),
      delete: async (k) => void map.delete(k),
    };
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({ ...base, store, fetch });
    await auth.getToken();
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("serves a token another process already put there", async () => {
    const store = trackingStore();
    const seeded = createClientCredentialsAuth({ ...base, store, fetch: tokenEndpoint(granted()) });
    await seeded.getToken();

    const fresh = tokenEndpoint(granted());
    const second = createClientCredentialsAuth({ ...base, store, fetch: fresh });
    await second.getToken();
    expect(fresh).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it("maps an RFC 6749 error response to OAuthError", async () => {
    const fetch = tokenEndpoint(
      denied(401, { error: "invalid_client", error_description: "bad secret" }),
    );
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await expect(auth.getToken()).rejects.toMatchObject({
      name: "OAuthError",
      error: "invalid_client",
      errorDescription: "bad secret",
      status: 401,
      tokenUrl: TOKEN_URL,
    });
  });

  it("falls back to the status when the body names no error", async () => {
    const fetch = tokenEndpoint(denied(500, {}));
    await expect(createClientCredentialsAuth({ ...base, fetch }).getToken()).rejects.toMatchObject({
      error: "http_500",
    });
  });

  it("reports a non-JSON body as invalid_response rather than a parse crash", async () => {
    const fetch = tokenEndpoint(
      () => new Response("<html>gateway timeout</html>", { status: 504 }),
    );
    await expect(createClientCredentialsAuth({ ...base, fetch }).getToken()).rejects.toMatchObject({
      error: "invalid_response",
    });
  });

  it("rejects a 200 that carries no access_token", async () => {
    const fetch = tokenEndpoint(
      () =>
        new Response(JSON.stringify({ token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(createClientCredentialsAuth({ ...base, fetch }).getToken()).rejects.toMatchObject({
      error: "invalid_response",
    });
  });

  it("gives up on a token endpoint that never answers", async () => {
    // Nothing else bounds getToken when it is called directly.
    const hanging = vi.fn(
      (_u: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createClientCredentialsAuth({ ...base, fetch: hanging, timeoutMs: 25 }).getToken(),
    ).rejects.toMatchObject({ name: "OAuthError", error: "timeout" });
  });

  it("gives up on a token endpoint that stalls mid-body", async () => {
    // Headers arriving is not the same as the body arriving. Without the
    // deadline staying armed, this hangs for as long as the connection does.
    const stalling = vi.fn(
      async (_u: unknown, init?: RequestInit) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_token":'));
              init?.signal?.addEventListener("abort", () => {
                controller.error(new Error("aborted"));
              });
              // Never closes.
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createClientCredentialsAuth({ ...base, fetch: stalling, timeoutMs: 25 }).getToken(),
    ).rejects.toMatchObject({ name: "OAuthError", error: "timeout" });
  });

  it("wraps a connection dropped mid-body as an OAuthError", async () => {
    // Everything out of this module should be catchable as one type.
    const dropping = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_token":'));
              controller.error(new Error("ECONNRESET"));
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof globalThis.fetch;

    await expect(
      createClientCredentialsAuth({ ...base, fetch: dropping }).getToken(),
    ).rejects.toMatchObject({ name: "OAuthError", error: "network_error" });
  });

  it("still reports a non-JSON body as invalid_response, not as a network error", async () => {
    // readJson already shapes this one; it must not be re-wrapped.
    const fetch = tokenEndpoint(() => new Response("<html>nope</html>", { status: 502 }));
    await expect(createClientCredentialsAuth({ ...base, fetch }).getToken()).rejects.toMatchObject({
      error: "invalid_response",
    });
  });

  it("wraps a transport failure", async () => {
    // Named for what it is: a local called `fetch` makes `typeof fetch` refer
    // to itself rather than to the global.
    const refusing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof globalThis.fetch;
    await expect(
      createClientCredentialsAuth({ ...base, fetch: refusing }).getToken(),
    ).rejects.toMatchObject({ error: "network_error" });
  });

  it("never puts the secret in the error message", async () => {
    const fetch = tokenEndpoint(denied(401, { error: "invalid_client" }));
    try {
      await createClientCredentialsAuth({ ...base, fetch }).getToken();
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("s3cr3t");
    }
  });
});

describe("the response", () => {
  // Time is frozen for this block. These assertions are about an exact
  // arithmetic relationship — expiresAt is the mint time plus the lifetime —
  // and against a running clock they depend on whether a millisecond boundary
  // happens to fall between reading the time and minting the token, which is a
  // coin flip rather than a test.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reads a numeric expires_in", async () => {
    const auth = createClientCredentialsAuth({ ...base, fetch: tokenEndpoint(granted()) });
    const token = await auth.getToken();
    expect(token.expiresAt).toBeGreaterThan(Date.now());
  });

  it("accepts expires_in sent as a string", async () => {
    const fetch = tokenEndpoint(granted({ expires_in: "120" }));
    const now = Date.now();
    const token = await createClientCredentialsAuth({ ...base, fetch }).getToken();
    expect(token.expiresAt).toBe(now + 120_000);
  });

  it("applies a conservative lifetime when expires_in is absent", async () => {
    const fetch = tokenEndpoint(
      () =>
        new Response(JSON.stringify({ access_token: "t", token_type: "Bearer" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const now = Date.now();
    const token = await createClientCredentialsAuth({ ...base, fetch }).getToken();
    // Caching indefinitely would mean being rejected later with no way back.
    expect(token.expiresAt).toBe(now + 300_000);
  });

  it("keeps the granted scope, which may be narrower than requested", async () => {
    const fetch = tokenEndpoint(granted({ scope: "a:read" }));
    const token = await createClientCredentialsAuth({
      ...base,
      scope: ["a:read", "b:write"],
      fetch,
    }).getToken();
    expect(token.scope).toBe("a:read");
  });
});

describe("the auth provider", () => {
  it("produces a bearer Authorization header", async () => {
    const auth = createClientCredentialsAuth({ ...base, fetch: tokenEndpoint(granted()) });
    await expect(
      auth.authProvider({
        url: "https://api.test/x",
        method: "GET",
        service: undefined,
        isFormData: false,
        context: undefined,
        attempt: 1,
      }),
    ).resolves.toEqual({ Authorization: "Bearer token-1" });
  });

  it("uses the token_type the server returned", async () => {
    const fetch = tokenEndpoint(granted({ token_type: "DPoP" }));
    const auth = createClientCredentialsAuth({ ...base, fetch });
    const headers = (await auth.authProvider({
      url: "https://api.test/x",
      method: "GET",
      service: undefined,
      isFormData: false,
      context: undefined,
      attempt: 1,
    })) as Record<string, string>;
    expect(headers["Authorization"]).toBe("DPoP token-1");
  });

  it("honours a custom header name and scheme", async () => {
    const auth = createClientCredentialsAuth({
      ...base,
      headerName: "X-Access-Token",
      scheme: "Token",
      fetch: tokenEndpoint(granted()),
    });
    const headers = (await auth.authProvider({
      url: "https://api.test/x",
      method: "GET",
      service: undefined,
      isFormData: false,
      context: undefined,
      attempt: 1,
    })) as Record<string, string>;
    expect(headers["X-Access-Token"]).toBe("Token token-1");
  });
});

describe("onAuthFailure", () => {
  it("drops the cached token and asks for another attempt", async () => {
    const fetch = tokenEndpoint(granted());
    const auth = createClientCredentialsAuth({ ...base, fetch });
    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(auth.onAuthFailure()).resolves.toBe(true);

    await auth.getToken();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
