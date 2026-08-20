import { describe, expect, it, vi } from "vitest";

import { RestClient } from "../client.js";

import { createClientCredentialsAuth } from "./client-credentials.js";

const TOKEN_URL = "https://auth.test/oauth2/token";
const API = "https://api.test";

/**
 * One fetch standing in for both the token endpoint and the API, so a request
 * travels the whole path: mint, call, get rejected, re-mint, call again.
 */
function world(options: { acceptTokens: string[] }) {
  const issued: string[] = [];
  const apiCalls: Array<string | null> = [];
  let counter = 0;

  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);

    if (target === TOKEN_URL) {
      counter += 1;
      const token = `token-${counter}`;
      issued.push(token);
      return new Response(
        JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const authorization = new Headers(init?.headers).get("Authorization");
    apiCalls.push(authorization);

    const presented = authorization?.replace("Bearer ", "") ?? "";
    if (!options.acceptTokens.includes(presented)) {
      return new Response(JSON.stringify({ error: "invalid_token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return Object.assign(impl as unknown as typeof globalThis.fetch, { issued, apiCalls });
}

function build(fetch: typeof globalThis.fetch) {
  const auth = createClientCredentialsAuth({
    tokenUrl: TOKEN_URL,
    clientId: "client-1",
    clientSecret: "s3cr3t",
    fetch,
  });

  const api = new RestClient({
    baseUrl: API,
    fetch,
    authProvider: auth.authProvider,
    retry: { onAuthFailure: auth.onAuthFailure, delayMs: 0 },
  });

  return { auth, api };
}

describe("client credentials through the client", () => {
  it("mints a token, attaches it, and succeeds", async () => {
    const fetch = world({ acceptTokens: ["token-1"] });
    const { api } = build(fetch);

    const response = await api.get<{ ok: boolean }>("/things");

    expect(response.status).toBe(200);
    expect(fetch.apiCalls).toEqual(["Bearer token-1"]);
  });

  it("re-mints and retries once when the server rejects the token", async () => {
    // The server only ever accepts the second token, so the first call must be
    // rejected, the cached token dropped, a new one minted, and the request
    // retried with it.
    const fetch = world({ acceptTokens: ["token-2"] });
    const { api } = build(fetch);

    const response = await api.get("/things");

    expect(response.status).toBe(200);
    expect(fetch.issued).toEqual(["token-1", "token-2"]);
    expect(fetch.apiCalls).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("gives up rather than looping when the fresh token is rejected too", async () => {
    // A credential the server will never accept must not spin.
    const fetch = world({ acceptTokens: [] });
    const { api } = build(fetch);

    const response = await api.get("/things");

    expect(response.status).toBe(401);
    expect(fetch.apiCalls).toHaveLength(2);
  });

  it("reuses the cached token across requests", async () => {
    const fetch = world({ acceptTokens: ["token-1"] });
    const { api } = build(fetch);

    await api.get("/a");
    await api.get("/b");
    await api.get("/c");

    expect(fetch.issued).toEqual(["token-1"]);
  });

  it("mints once for a concurrent burst", async () => {
    const fetch = world({ acceptTokens: ["token-1"] });
    const { api } = build(fetch);

    await Promise.all(Array.from({ length: 10 }, (_v, i) => api.get(`/thing-${i}`)));

    expect(fetch.issued).toEqual(["token-1"]);
    expect(fetch.apiCalls).toHaveLength(10);
  });

  it("keeps the secret out of a logged request", async () => {
    const fetch = world({ acceptTokens: ["token-1"] });
    const auth = createClientCredentialsAuth({
      tokenUrl: TOKEN_URL,
      clientId: "client-1",
      clientSecret: "s3cr3t",
      fetch,
    });
    const lines: string[] = [];
    const api = new RestClient({
      baseUrl: API,
      fetch,
      authProvider: auth.authProvider,
      logger: {
        request: ({ headers }) => {
          headers.forEach((value) => lines.push(value));
        },
      },
    });

    await api.get("/things");
    // The logger receives the real headers; it is redactHeaders that protects
    // them. What must never happen is the secret reaching the API request.
    expect(lines.join(" ")).not.toContain("s3cr3t");
  });
});
