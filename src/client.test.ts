import { describe, expect, it, vi } from "vitest";

import { type AuthContext, RestClient } from "./client.js";
import { HttpError, NetworkError, TimeoutError } from "./errors.js";

/** A fetch stand-in that records what it was called with. */
function stubFetch(...responses: Array<Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return typeof next === "function" ? next() : (next ?? new Response(null, { status: 200 }));
  });
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
    });
}

const headersOf = (init: RequestInit) => init.headers as Headers;

/**
 * A fetch that never answers, and rejects when its signal aborts.
 *
 * It has to check `aborted` up front as well as listen: the signal can
 * already be aborted by the time the request is made, and a real fetch
 * rejects immediately rather than waiting for an event that has been and
 * gone.
 */
const never = () =>
  vi.fn(
    (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  ) as unknown as typeof fetch;

describe("RestClient", () => {
  describe("url resolution", () => {
    it("joins a relative path onto the base", async () => {
      const f = stubFetch(json({}));
      await new RestClient({ baseUrl: "https://api.test", fetch: f }).get("/users");
      expect(f.calls[0]?.url).toBe("https://api.test/users");
    });

    it("passes an absolute url through untouched", async () => {
      const f = stubFetch(json({}));
      await new RestClient({ baseUrl: "https://api.test", fetch: f }).get("https://other.test/x");
      expect(f.calls[0]?.url).toBe("https://other.test/x");
    });

    it("routes through a named service", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({ services: { search: "https://search.test" }, fetch: f });
      await api.get("/q", { service: "search" });
      expect(f.calls[0]?.url).toBe("https://search.test/q");
    });

    it("names the configured services when asked for one that is not", () => {
      const api = new RestClient({ services: { search: "https://search.test" } });
      expect(() => api.path("billing", "/x")).toThrow(/Configured services: search/);
    });

    it("explains itself when a relative path has nothing to resolve against", async () => {
      const api = new RestClient({ fetch: stubFetch(json({})) });
      await expect(api.get("/users")).rejects.toThrow(/no baseUrl/);
    });

    it("appends query parameters", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await api.get("/s", { query: { q: "a b", tag: ["x", "y"], skip: undefined } });
      expect(f.calls[0]?.url).toBe("https://api.test/s?q=a+b&tag=x&tag=y");
    });
  });

  describe("bodies", () => {
    it("sends JSON and declares the content type", async () => {
      const f = stubFetch(json({}));
      await new RestClient({ baseUrl: "https://api.test", fetch: f }).post("/x", { a: 1 });
      expect(f.calls[0]?.init.body).toBe('{"a":1}');
      expect(headersOf(f.calls[0]!.init).get("Content-Type")).toBe("application/json");
    });

    it("leaves the content type unset for FormData", async () => {
      const f = stubFetch(json({}));
      const form = new FormData();
      form.set("file", "contents");
      await new RestClient({ baseUrl: "https://api.test", fetch: f }).post("/upload", form);
      expect(headersOf(f.calls[0]!.init).get("Content-Type")).toBeNull();
      expect(f.calls[0]?.init.body).toBe(form);
    });

    it("omits the body entirely when there is none", async () => {
      const f = stubFetch(json({}));
      await new RestClient({ baseUrl: "https://api.test", fetch: f }).post("/ping");
      expect(f.calls[0]?.init.body).toBeUndefined();
    });

    it.each(["put", "patch", "delete"] as const)("supports %s with a body", async (verb) => {
      const f = stubFetch(json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await api[verb]("/x", { a: 1 });
      expect(f.calls[0]?.init.method).toBe(verb.toUpperCase());
      expect(f.calls[0]?.init.body).toBe('{"a":1}');
    });
  });

  describe("responses", () => {
    it("decodes JSON carrying a charset", async () => {
      const f = stubFetch(json({ name: "ada" }));
      const res = await new RestClient({ baseUrl: "https://api.test", fetch: f }).get<{
        name: string;
      }>("/u");
      expect(res.body).toEqual({ name: "ada" });
      expect(res.bodyType).toBe("application/json");
      expect(res.ok).toBe(true);
    });

    it("returns a non-2xx as a value rather than throwing", async () => {
      const f = stubFetch(json({ error: "nope" }, 404));
      const res = await new RestClient({ baseUrl: "https://api.test", fetch: f }).get("/missing");
      expect(res.status).toBe(404);
      expect(res.ok).toBe(false);
      expect(() => res.getOrThrow()).toThrow(HttpError);
    });

    it("handles a 204 without a body", async () => {
      const f = stubFetch(() => new Response(null, { status: 204 }));
      const res = await new RestClient({ baseUrl: "https://api.test", fetch: f }).delete("/x");
      expect(res.body).toBeUndefined();
      expect(res.status).toBe(204);
    });

    it("exposes the raw response and its headers", async () => {
      const f = stubFetch(json({}, 200, { "X-Request-Id": "abc" }));
      const res = await new RestClient({ baseUrl: "https://api.test", fetch: f }).get("/x");
      expect(res.headers.get("X-Request-Id")).toBe("abc");
      expect(res.raw).toBeInstanceOf(Response);
    });
  });

  describe("headers", () => {
    it("applies static client headers", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        headers: { "X-Client": "test" },
      });
      await api.get("/x");
      expect(headersOf(f.calls[0]!.init).get("X-Client")).toBe("test");
    });

    it("resolves a header function per request", async () => {
      const f = stubFetch(json({}), json({}));
      let n = 0;
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        headers: () => ({ "X-Seq": String(++n) }),
      });
      await api.get("/x");
      await api.get("/y");
      expect(headersOf(f.calls[0]!.init).get("X-Seq")).toBe("1");
      expect(headersOf(f.calls[1]!.init).get("X-Seq")).toBe("2");
    });

    it("merges init.headers instead of dropping them", async () => {
      // The composed Headers object is assigned last when the request is built,
      // so anything left on RequestInit would be silently discarded.
      const f = stubFetch(json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await api.get("/x", { init: { headers: { "X-Trace": "abc" } } });
      expect(headersOf(f.calls[0]!.init).get("X-Trace")).toBe("abc");
    });

    it("layers sources in precedence order", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        defaultInit: { headers: { "X-Layer": "default" } },
        headers: { "X-Layer": "client" },
        authProvider: () => ({ "X-Layer": "auth" }),
      });
      await api.get("/x", { headers: { "X-Layer": "call" } });
      expect(headersOf(f.calls[0]!.init).get("X-Layer")).toBe("call");
    });

    it("lets the auth provider override the client headers", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        headers: { "X-Layer": "client" },
        authProvider: () => ({ "X-Layer": "auth" }),
      });
      await api.get("/x");
      expect(headersOf(f.calls[0]!.init).get("X-Layer")).toBe("auth");
    });

    it("lets a caller override the body's content type", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await api.post(
        "/x",
        { a: 1 },
        { headers: { "Content-Type": "application/merge-patch+json" } },
      );
      expect(headersOf(f.calls[0]!.init).get("Content-Type")).toBe("application/merge-patch+json");
    });
  });

  describe("authProvider", () => {
    it("receives the request context", async () => {
      const f = stubFetch(json({}));
      const provider = vi.fn(() => ({ Authorization: "Bearer t" }));
      const api = new RestClient({
        services: { search: "https://search.test" },
        fetch: f,
        authProvider: provider,
        context: { tenant: "acme" },
      });
      await api.get("/q", { service: "search" });
      expect(provider).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "https://search.test/q",
          method: "GET",
          service: "search",
          isFormData: false,
          context: { tenant: "acme" },
          attempt: 1,
        }),
      );
    });

    it("flags a multipart body", async () => {
      const f = stubFetch(json({}));
      const provider = vi.fn((_context: AuthContext<never>) => ({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f, authProvider: provider });
      const form = new FormData();
      await api.post("/x", form);
      expect(provider.mock.calls[0]?.[0]).toMatchObject({ isFormData: true });
    });

    it("accepts an async provider", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        authProvider: async () => ({ Authorization: "Bearer async" }),
      });
      await api.get("/x");
      expect(headersOf(f.calls[0]!.init).get("Authorization")).toBe("Bearer async");
    });

    it("takes a per-request context over the client default", async () => {
      const f = stubFetch(json({}));
      const provider = vi.fn((_context: AuthContext<{ user: string }>) => ({}));
      const api = new RestClient<{ user: string }>({
        baseUrl: "https://api.test",
        fetch: f,
        authProvider: provider,
        context: { user: "default" },
      });
      await api.get("/x", { context: { user: "specific" } });
      expect(provider.mock.calls[0]?.[0]).toMatchObject({ context: { user: "specific" } });
    });
  });

  describe("with()", () => {
    it("derives a client carrying extra context", async () => {
      const f = stubFetch(json({}));
      const provider = vi.fn((_context: AuthContext<{ user: string }>) => ({}));
      const api = new RestClient<{ user: string }>({
        baseUrl: "https://api.test",
        fetch: f,
        authProvider: provider,
      });
      await api.with({ context: { user: "ada" } }).get("/x");
      expect(provider.mock.calls[0]?.[0]).toMatchObject({ context: { user: "ada" } });
    });

    it("merges headers from both levels", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        headers: { "X-Parent": "p" },
      });
      await api.with({ headers: { "X-Child": "c" } }).get("/x");
      const sent = headersOf(f.calls[0]!.init);
      expect(sent.get("X-Parent")).toBe("p");
      expect(sent.get("X-Child")).toBe("c");
    });

    it("lets the child override a parent header", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f, headers: { X: "p" } });
      await api.with({ headers: { X: "c" } }).get("/x");
      expect(headersOf(f.calls[0]!.init).get("X")).toBe("c");
    });

    it("leaves the parent untouched", async () => {
      const f = stubFetch(json({}), json({}));
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await api.with({ headers: { "X-Child": "c" } }).get("/x");
      await api.get("/y");
      expect(headersOf(f.calls[1]!.init).get("X-Child")).toBeNull();
    });

    it("combines the service maps", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({ services: { a: "https://a.test" }, fetch: f });
      const child = api.with({ services: { b: "https://b.test" } });
      expect(child.path("a", "/x")).toBe("https://a.test/x");
      expect(child.path("b", "/x")).toBe("https://b.test/x");
    });
  });

  describe("retry", () => {
    it("does not retry unless configured", async () => {
      const f = stubFetch(json({}, 503));
      const res = await new RestClient({ baseUrl: "https://api.test", fetch: f }).get("/x");
      expect(f).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(503);
    });

    it("retries a retryable status and returns the eventual success", async () => {
      const f = stubFetch(json({}, 503), json({}, 503), json({ ok: true }));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 3, delayMs: 0 },
      });
      const res = await api.get("/x");
      expect(f).toHaveBeenCalledTimes(3);
      expect(res.status).toBe(200);
    });

    it("returns the last response when attempts run out", async () => {
      // The original threw "Retries exceeded", discarding the actual response.
      const f = stubFetch(json({ error: "still down" }, 503));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 2, delayMs: 0 },
      });
      const res = await api.get("/x");
      expect(f).toHaveBeenCalledTimes(2);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: "still down" });
    });

    it("calls the refresh hook on 401 and retries once", async () => {
      const refresh = vi.fn(async () => true);
      const f = stubFetch(json({}, 401), json({ ok: true }));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { onAuthFailure: refresh, delayMs: 0 },
      });
      const res = await api.get("/private");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(f).toHaveBeenCalledTimes(2);
      expect(res.status).toBe(200);
    });

    it("gives up when the refresh hook declines", async () => {
      const refresh = vi.fn(async () => false);
      const f = stubFetch(json({}, 401));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { onAuthFailure: refresh, delayMs: 0 },
      });
      const res = await api.get("/private");
      expect(f).toHaveBeenCalledTimes(1);
      expect(res.status).toBe(401);
    });

    it("rebuilds credentials on the retry so a refresh takes effect", async () => {
      let token = "stale";
      const f = stubFetch(json({}, 401), json({ ok: true }));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        authProvider: () => ({ Authorization: `Bearer ${token}` }),
        retry: {
          delayMs: 0,
          onAuthFailure: () => {
            token = "fresh";
            return true;
          },
        },
      });
      await api.get("/private");
      expect(headersOf(f.calls[0]!.init).get("Authorization")).toBe("Bearer stale");
      expect(headersOf(f.calls[1]!.init).get("Authorization")).toBe("Bearer fresh");
    });

    it("retries a network failure", async () => {
      let n = 0;
      const f = vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("ECONNREFUSED");
        return new Response("{}", { headers: { "Content-Type": "application/json" } });
      }) as unknown as typeof fetch;
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 2, delayMs: 0 },
      });
      await expect(api.get("/x")).resolves.toMatchObject({ status: 200 });
    });

    it("wraps an exhausted network failure as a NetworkError", async () => {
      const f = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch;
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f });
      await expect(api.get("/x")).rejects.toBeInstanceOf(NetworkError);
    });

    it("honours a Retry-After header", async () => {
      const f = stubFetch(json({}, 429, { "Retry-After": "1" }), json({ ok: true }));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 2, maxDelayMs: 5 },
      });
      // maxDelayMs clamps the server's one-second request, so this stays fast.
      await api.get("/x");
      expect(f).toHaveBeenCalledTimes(2);
    });

    it("ignores Retry-After when the policy says not to respect it", async () => {
      const f = stubFetch(json({}, 429, { "Retry-After": "3600" }), json({ ok: true }));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 2, delayMs: 0, respectRetryAfter: false },
      });
      await api.get("/x");
      expect(f).toHaveBeenCalledTimes(2);
    });
  });

  describe("timeout and cancellation", () => {
    it("raises a TimeoutError carrying the budget", async () => {
      const api = new RestClient({ baseUrl: "https://api.test", fetch: never(), timeoutMs: 20 });
      await expect(api.get("/slow")).rejects.toMatchObject({
        name: "TimeoutError",
        timeoutMs: 20,
      });
    });

    it("accepts a per-request timeout over the client default", async () => {
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: never(),
        timeoutMs: 10_000,
      });
      await expect(api.get("/slow", { timeoutMs: 20 })).rejects.toBeInstanceOf(TimeoutError);
    });

    it("reports a caller's cancellation as a NetworkError, not a timeout", async () => {
      const controller = new AbortController();
      const api = new RestClient({ baseUrl: "https://api.test", fetch: never() });
      const pending = api.get("/slow", { signal: controller.signal });
      controller.abort(new Error("user navigated away"));
      await expect(pending).rejects.toBeInstanceOf(NetworkError);
    });

    it.each([
      ["options.signal", (signal: AbortSignal) => ({ signal })],
      ["init.signal", (signal: AbortSignal) => ({ init: { signal } })],
    ])("honours a caller signal passed as %s", async (_label, build) => {
      // The composed signal is assigned last when the request is built, so a
      // signal left on a RequestInit was previously overwritten and ignored.
      const controller = new AbortController();
      const api = new RestClient({ baseUrl: "https://api.test", fetch: never() });
      const pending = api.get("/slow", build(controller.signal));
      controller.abort(new Error("stop"));
      await expect(pending).rejects.toBeInstanceOf(NetworkError);
    });

    it("honours a signal supplied on defaultInit", async () => {
      const controller = new AbortController();
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: never(),
        defaultInit: { signal: controller.signal },
      });
      const pending = api.get("/slow");
      controller.abort(new Error("stop"));
      await expect(pending).rejects.toBeInstanceOf(NetworkError);
    });

    it("keeps the deadline running while the body is read", async () => {
      // A response arriving only means its headers did. A body that stalls
      // mid-stream must still hit the timeout rather than hang.
      const stalling = vi.fn(
        async (_u: unknown, init?: RequestInit) =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"partial":'));
                init?.signal?.addEventListener("abort", () => {
                  controller.error(new Error("aborted"));
                });
                // Never closes: the rest of the body never arrives.
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ) as unknown as typeof fetch;

      const api = new RestClient({ baseUrl: "https://api.test", fetch: stalling, timeoutMs: 30 });
      await expect(api.get("/stalls")).rejects.toBeInstanceOf(TimeoutError);
    });

    it("surfaces a genuine decoding failure as itself", async () => {
      // Malformed JSON from a server that claimed JSON is not a timeout.
      const f = stubFetch(
        () => new Response("{oh no", { headers: { "Content-Type": "application/json" } }),
      );
      const api = new RestClient({ baseUrl: "https://api.test", fetch: f, timeoutMs: 5000 });
      await expect(api.get("/bad")).rejects.not.toBeInstanceOf(TimeoutError);
    });

    it("does not retry a cancelled request", async () => {
      const controller = new AbortController();
      const f = never();
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        retry: { attempts: 3, delayMs: 0 },
      });
      const pending = api.get("/slow", { signal: controller.signal });
      controller.abort(new Error("stop"));
      await expect(pending).rejects.toBeInstanceOf(NetworkError);
      // At most one attempt: no retry. Possibly none at all — cancelling before
      // the headers resolve stops the request being issued in the first place,
      // since header building is inside the deadline too.
      expect(
        (f as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
      ).toBeLessThanOrEqual(1);
    });
  });

  describe("ok()", () => {
    it("reports a 2xx as true", async () => {
      const api = new RestClient({ baseUrl: "https://api.test", fetch: stubFetch(json({})) });
      await expect(api.ok("/health")).resolves.toBe(true);
    });

    it("reports a non-2xx as false rather than throwing", async () => {
      const api = new RestClient({ baseUrl: "https://api.test", fetch: stubFetch(json({}, 503)) });
      await expect(api.ok("/health")).resolves.toBe(false);
    });

    it("reports a network failure as false", async () => {
      const f = vi.fn(async () => {
        throw new Error("down");
      }) as unknown as typeof fetch;
      await expect(
        new RestClient({ baseUrl: "https://api.test", fetch: f }).ok("/health"),
      ).resolves.toBe(false);
    });
  });

  describe("configuration", () => {
    it("passes defaultInit through to fetch", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        defaultInit: { cache: "no-store", credentials: "include" },
      });
      await api.get("/x");
      expect(f.calls[0]?.init).toMatchObject({ cache: "no-store", credentials: "include" });
    });

    it("lets a per-request init override defaultInit", async () => {
      const f = stubFetch(json({}));
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: f,
        defaultInit: { cache: "no-store" },
      });
      await api.get("/x", { init: { cache: "reload" } });
      expect(f.calls[0]?.init.cache).toBe("reload");
    });

    it("reports a missing fetch implementation clearly", async () => {
      const api = new RestClient({ baseUrl: "https://api.test", fetch: undefined as never });
      const original = globalThis.fetch;
      // @ts-expect-error deliberately removing the global for this assertion
      delete globalThis.fetch;
      try {
        await expect(api.get("/x")).rejects.toThrow(/No fetch implementation/);
      } finally {
        globalThis.fetch = original;
      }
    });

    it("reports requests and responses to a logger", async () => {
      const request = vi.fn();
      const response = vi.fn();
      const api = new RestClient({
        baseUrl: "https://api.test",
        fetch: stubFetch(json({})),
        logger: { request, response },
      });
      await api.get("/x");
      expect(request).toHaveBeenCalledOnce();
      expect(response).toHaveBeenCalledWith(expect.objectContaining({ status: 200 }));
    });
  });
});
