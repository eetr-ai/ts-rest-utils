import { describe, expect, it } from "vitest";

import { buildUrl, createEndpoints, resolveBase, withQuery } from "./url.js";

describe("buildUrl", () => {
  it("treats a leading slash as rooted at the base", () => {
    expect(buildUrl("/users", "https://api.test")).toBe("https://api.test/users");
  });

  it("appends a path without a leading slash as a segment", () => {
    expect(buildUrl("users", "https://api.test")).toBe("https://api.test/users");
  });

  it("does not double the separator when the base has a trailing slash", () => {
    expect(buildUrl("/users", "https://api.test/")).toBe("https://api.test/users");
    expect(buildUrl("users", "https://api.test/")).toBe("https://api.test/users");
  });

  it("preserves a base that already carries a path prefix", () => {
    expect(buildUrl("/users", "https://api.test/v2")).toBe("https://api.test/v2/users");
  });

  it.each(["", " ", "\t", "\n  "])("rejects the empty-ish path %j", (path) => {
    // Almost always an unset variable rather than a request for the base URL.
    expect(() => buildUrl(path, "https://api.test")).toThrow(TypeError);
  });
});

describe("withQuery", () => {
  it("returns the url untouched when there are no params", () => {
    expect(withQuery("https://api.test/x")).toBe("https://api.test/x");
    expect(withQuery("https://api.test/x", {})).toBe("https://api.test/x");
  });

  it("encodes values", () => {
    expect(withQuery("https://api.test/s", { q: "a b&c" })).toBe("https://api.test/s?q=a+b%26c");
  });

  it("repeats the key for each element of an array", () => {
    expect(withQuery("https://api.test/s", { tag: ["a", "b"] })).toBe(
      "https://api.test/s?tag=a&tag=b",
    );
  });

  it("skips undefined and null rather than stringifying them", () => {
    // The bug this guards: `?a=undefined` reaching the server as a literal.
    expect(withQuery("https://api.test/s", { a: undefined, b: null, c: 1 })).toBe(
      "https://api.test/s?c=1",
    );
  });

  it("keeps an empty string, which is a real value", () => {
    expect(withQuery("https://api.test/s", { q: "" })).toBe("https://api.test/s?q=");
  });

  it("serialises numbers and booleans", () => {
    expect(withQuery("https://api.test/s", { n: 0, ok: false })).toBe(
      "https://api.test/s?n=0&ok=false",
    );
  });

  it("appends to a url that already has a query", () => {
    expect(withQuery("https://api.test/s?a=1", { b: 2 })).toBe("https://api.test/s?a=1&b=2");
  });

  it("produces nothing when every value is skipped", () => {
    expect(withQuery("https://api.test/s", { a: undefined })).toBe("https://api.test/s");
  });

  it("inserts the query before a fragment", () => {
    // Appending to the whole string would put the query inside the fragment,
    // where it never reaches the server.
    expect(withQuery("https://api.test/p#top", { a: 1 })).toBe("https://api.test/p?a=1#top");
  });

  it("merges into an existing query that precedes a fragment", () => {
    expect(withQuery("https://api.test/p?z=0#top", { a: 1 })).toBe(
      "https://api.test/p?z=0&a=1#top",
    );
  });

  it("leaves a fragment alone when there is nothing to add", () => {
    expect(withQuery("https://api.test/p#top", { a: undefined })).toBe("https://api.test/p#top");
  });
});

describe("createEndpoints", () => {
  const endpoints = createEndpoints({
    billing: "https://billing.test",
    search: "https://search.test/v1",
  });

  it("builds a path per named service", () => {
    expect(endpoints.billing("/invoices")).toBe("https://billing.test/invoices");
    expect(endpoints.search("query")).toBe("https://search.test/v1/query");
  });

  it("applies buildUrl's validation", () => {
    expect(() => endpoints.billing("")).toThrow(TypeError);
  });
});

describe("resolveBase", () => {
  const bases = ["https://api.test", "https://api.test/search"];

  it("returns the matching base", () => {
    expect(resolveBase("https://api.test/users", bases)).toBe("https://api.test");
  });

  it("prefers the longest match when bases overlap", () => {
    expect(resolveBase("https://api.test/search/q", bases)).toBe("https://api.test/search");
  });

  it("matches the base exactly, with no path", () => {
    expect(resolveBase("https://api.test", bases)).toBe("https://api.test");
  });

  it.each(["?a=1", "#frag", "/x"])("matches when the base is followed by %j", (suffix) => {
    expect(resolveBase(`https://api.test${suffix}`, bases)).toBe("https://api.test");
  });

  it.each([
    "https://api.test.attacker.test/x",
    "https://api.testing.example/x",
    "https://api.testattacker/x",
  ])("does not match the lookalike host %j", (url) => {
    // A bare startsWith would accept all of these, and resolving a base is how
    // an auth provider decides which credential to attach.
    expect(resolveBase(url, bases)).toBeUndefined();
  });

  it("returns undefined when nothing matches", () => {
    expect(resolveBase("https://elsewhere.test/x", bases)).toBeUndefined();
  });

  it("ignores empty entries and tolerates an empty list", () => {
    expect(resolveBase("https://api.test/x", ["", "https://api.test"])).toBe("https://api.test");
    expect(resolveBase("https://api.test/x", [])).toBeUndefined();
  });

  it("treats a trailing slash on the base as equivalent", () => {
    expect(resolveBase("https://api.test/x", ["https://api.test/"])).toBe("https://api.test/");
  });
});
