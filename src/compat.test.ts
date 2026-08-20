import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configure,
  deleteApi,
  getApi,
  getDefaultClient,
  patchApi,
  postApi,
  putApi,
  resetDefaultClient,
} from "./compat.js";

function stubFetch() {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response('{"ok":true}', {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  });
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

afterEach(() => resetDefaultClient());

describe("the default client", () => {
  it("starts unconfigured, so a relative path has nothing to resolve", async () => {
    await expect(getApi("/users")).rejects.toThrow(/no baseUrl/);
  });

  it("is replaced by configure(), which returns it", () => {
    const client = configure({ baseUrl: "https://api.test" });
    expect(client).toBe(getDefaultClient());
  });

  it("is restored by resetDefaultClient()", async () => {
    configure({ baseUrl: "https://api.test", fetch: stubFetch() });
    resetDefaultClient();
    await expect(getApi("/users")).rejects.toThrow(/no baseUrl/);
  });
});

describe("verb helpers", () => {
  it.each([
    ["getApi", () => getApi("/x"), "GET", undefined],
    ["postApi", () => postApi("/x", { a: 1 }), "POST", '{"a":1}'],
    ["putApi", () => putApi("/x", { a: 1 }), "PUT", '{"a":1}'],
    ["patchApi", () => patchApi("/x", { a: 1 }), "PATCH", '{"a":1}'],
    ["deleteApi", () => deleteApi("/x", { a: 1 }), "DELETE", '{"a":1}'],
  ])("%s issues the right method and body", async (_name, call, method, body) => {
    const f = stubFetch();
    configure({ baseUrl: "https://api.test", fetch: f });
    await call();
    expect(f.calls[0]?.init.method).toBe(method);
    expect(f.calls[0]?.init.body).toBe(body);
  });

  it("returns an ApiResponse with the accessors intact", async () => {
    configure({ baseUrl: "https://api.test", fetch: stubFetch() });
    const res = await getApi<{ ok: boolean }>("/x");
    expect(res.getOrThrow()).toEqual({ ok: true });
    expect(res.getOrNull()).toEqual({ ok: true });
    expect(res.ok).toBe(true);
  });

  it("accepts a full url as well as a path", async () => {
    const f = stubFetch();
    configure({ fetch: f });
    await getApi("https://elsewhere.test/x");
    expect(f.calls[0]?.url).toBe("https://elsewhere.test/x");
  });

  it("forwards per-request options", async () => {
    const f = stubFetch();
    configure({ baseUrl: "https://api.test", fetch: f });
    await getApi("/x", { query: { a: 1 }, headers: { "X-Trace": "t" } });
    expect(f.calls[0]?.url).toBe("https://api.test/x?a=1");
    expect((f.calls[0]!.init.headers as Headers).get("X-Trace")).toBe("t");
  });

  it("uses whichever client configure() installed most recently", async () => {
    const first = stubFetch();
    const second = stubFetch();
    configure({ baseUrl: "https://one.test", fetch: first });
    configure({ baseUrl: "https://two.test", fetch: second });
    await getApi("/x");
    expect(first).not.toHaveBeenCalled();
    expect(second.calls[0]?.url).toBe("https://two.test/x");
  });
});
