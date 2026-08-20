import { describe, expect, it, vi } from "vitest";

import {
  consoleLogger,
  isSensitiveHeader,
  noopLogger,
  redactHeaders,
  redactUrl,
} from "./logger.js";

describe("isSensitiveHeader", () => {
  it.each([
    "authorization",
    "Authorization",
    "proxy-authorization",
    "cookie",
    "set-cookie",
    "www-authenticate",
  ])("treats the standard credential header %j as sensitive", (name) => {
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each([
    "x-api-key",
    "x-api_key",
    "x-apikey",
    "x-id-token",
    "x-refresh-token",
    "x-client-secret",
    "x-signature",
    "x-user-password",
    "client-assertion",
  ])("catches the custom credential header %j by pattern", (name) => {
    // The library cannot know an organisation's header names, so the pattern
    // covers the words such headers are actually built from.
    expect(isSensitiveHeader(name)).toBe(true);
  });

  it.each(["content-type", "accept", "user-agent", "x-request-id", "x-tenant"])(
    "leaves the ordinary header %j alone",
    (name) => {
      expect(isSensitiveHeader(name)).toBe(false);
    },
  );
});

describe("redactHeaders", () => {
  it("replaces sensitive values but keeps their names", () => {
    // Knowing that a request carried an Authorization header is exactly what
    // you need when debugging a 401. Its value never is.
    const headers = new Headers({
      Authorization: "Bearer sk-secret-value",
      "X-Api-Key": "key-12345",
      "Content-Type": "application/json",
    });
    const safe = redactHeaders(headers);
    expect(safe["authorization"]).toBe("<redacted>");
    expect(safe["x-api-key"]).toBe("<redacted>");
    expect(safe["content-type"]).toBe("application/json");
  });

  it("never leaks the secret into the output", () => {
    const headers = new Headers({ Authorization: "Bearer sk-secret-value" });
    expect(JSON.stringify(redactHeaders(headers))).not.toContain("sk-secret-value");
  });

  it("handles an empty set", () => {
    expect(redactHeaders(new Headers())).toEqual({});
  });
});

describe("redactUrl", () => {
  // A value that appears in no parameter name, so the assertion cannot pass or
  // fail on the name rather than the value.
  const VALUE = "zzTOPSECRETzz";

  it.each([
    "access_token",
    "refresh_token",
    "id_token",
    "api_key",
    "apikey",
    "client_secret",
    "signature",
    "code",
    "sig",
    "credential",
    "password",
  ])("redacts the value of %j", (param) => {
    const redacted = redactUrl(`https://api.test/p?${param}=${VALUE}`);
    expect(redacted).not.toContain(VALUE);
    expect(redacted).toContain("%3Credacted%3E");
  });

  it("redacts every occurrence of a repeated key", () => {
    // `set` collapses duplicates, which is why the implementation snapshots the
    // key list before mutating — a live iterator would skip the second one.
    const redacted = redactUrl("https://api.test/p?token=aaa&token=bbb");
    expect(redacted).not.toContain("aaa");
    expect(redacted).not.toContain("bbb");
  });

  it("keeps ordinary parameters", () => {
    expect(redactUrl("https://api.test/p?q=hi&page=2")).toBe("https://api.test/p?q=hi&page=2");
  });

  it("keeps the parameter name, which is the useful half", () => {
    expect(redactUrl("https://api.test/p?access_token=x")).toContain("access_token=");
  });

  it("returns an unparseable url unchanged rather than dropping it", () => {
    expect(redactUrl("not a url at all")).toBe("not a url at all");
  });

  describe("outside the query string", () => {
    it("redacts a token in the fragment", () => {
      // Where an OAuth implicit-flow redirect puts it, specifically so it is
      // not sent to the server — which does nothing to stop a client logging it.
      const redacted = redactUrl(`https://callback.test/#access_token=${VALUE}&state=abc`);
      expect(redacted).not.toContain(VALUE);
      expect(redacted).toContain("state=abc");
    });

    it("redacts a password in the userinfo", () => {
      const redacted = redactUrl(`https://user:${VALUE}@api.test/p`);
      expect(redacted).not.toContain(VALUE);
    });

    it("keeps the username, which identifies rather than authenticates", () => {
      expect(redactUrl(`https://ada:${VALUE}@api.test/p`)).toContain("ada");
    });

    it("leaves a plain anchor fragment alone", () => {
      expect(redactUrl("https://api.test/p#section-2")).toBe("https://api.test/p#section-2");
    });

    it("redacts all three at once", () => {
      const redacted = redactUrl(
        `https://user:${VALUE}@api.test/p?api_key=${VALUE}#id_token=${VALUE}`,
      );
      expect(redacted).not.toContain(VALUE);
    });
  });
});

describe("noopLogger", () => {
  it("defines no handlers, so the client stays silent by default", () => {
    expect(Object.keys(noopLogger)).toEqual([]);
  });
});

function spyConsole() {
  return { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

describe("consoleLogger", () => {
  const event = {
    method: "GET",
    url: "https://api.test/x",
    headers: new Headers(),
    attempt: 1,
  };

  it("logs the outgoing request", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).request?.(event);
    expect(out.log).toHaveBeenCalledWith("[rest] GET https://api.test/x");
  });

  it("marks a retried attempt", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).request?.({ ...event, attempt: 3 });
    expect(out.log).toHaveBeenCalledWith("[rest] GET https://api.test/x (attempt 3)");
  });

  it("logs a successful response to log", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).response?.({ ...event, status: 200, durationMs: 12.4 });
    expect(out.log).toHaveBeenCalledWith("[rest] GET https://api.test/x -> 200 (12ms)");
    expect(out.error).not.toHaveBeenCalled();
  });

  it("logs a 4xx or 5xx to error", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).response?.({ ...event, status: 503, durationMs: 5 });
    expect(out.error).toHaveBeenCalledWith("[rest] GET https://api.test/x -> 503 (5ms)");
  });

  it("logs a failure with its cause", () => {
    const out = spyConsole();
    const boom = new Error("connection refused");
    consoleLogger({ console: out }).error?.({ ...event, error: boom, durationMs: 3 });
    expect(out.error).toHaveBeenCalledWith("[rest] GET https://api.test/x failed after 3ms:", boom);
  });

  it("warns before a retry", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).retry?.({ ...event, status: 503, durationMs: 1 }, 250);
    expect(out.warn).toHaveBeenCalledWith("[rest] GET https://api.test/x retrying in 250ms");
  });

  it("redacts a credential in the logged url", () => {
    const out = spyConsole();
    consoleLogger({ console: out }).request?.({
      ...event,
      url: "https://api.test/x?access_token=sk-secret",
    });
    expect(String(out.log.mock.calls[0]?.[0])).not.toContain("sk-secret");
    expect(String(out.log.mock.calls[0]?.[0])).toContain("access_token=");
  });

  it("honours a custom prefix", () => {
    const out = spyConsole();
    consoleLogger({ console: out, prefix: "[billing]" }).request?.(event);
    expect(out.log).toHaveBeenCalledWith("[billing] GET https://api.test/x");
  });
});
