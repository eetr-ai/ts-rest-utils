import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { delayForAttempt, resolveRetryPolicy, retryAfterMs, sleep } from "./retry.js";

const ctx = (status: number) => ({
  attempt: 1,
  response: new Response(null, { status }),
  url: "u",
  method: "GET",
});

describe("resolveRetryPolicy", () => {
  it("disables retrying by default", () => {
    expect(resolveRetryPolicy().attempts).toBe(1);
    expect(resolveRetryPolicy({}).attempts).toBe(1);
  });

  it("allows a second attempt when a refresh hook is configured", () => {
    // A refresh hook with only one attempt could never use the new credential,
    // and would fail silently rather than visibly.
    const policy = resolveRetryPolicy({ onAuthFailure: () => true });
    expect(policy.attempts).toBe(2);
  });

  it("lets an explicit attempt count win over that inference", () => {
    expect(resolveRetryPolicy({ onAuthFailure: () => true, attempts: 5 }).attempts).toBe(5);
  });

  it("never drops below a single attempt", () => {
    expect(resolveRetryPolicy({ attempts: 0 }).attempts).toBe(1);
    expect(resolveRetryPolicy({ attempts: -3 }).attempts).toBe(1);
  });

  it("fills in the remaining defaults", () => {
    const p = resolveRetryPolicy();
    expect(p.delayMs).toBe(300);
    expect(p.backoff).toBe("exponential");
    expect(p.maxDelayMs).toBe(10_000);
    expect(p.retryOnNetworkError).toBe(true);
    expect(p.respectRetryAfter).toBe(true);
    expect(p.authFailureStatuses).toEqual([401]);
  });

  describe("retryOn", () => {
    it.each([408, 429, 500, 502, 503, 504])("retries %d by default", async (status) => {
      expect(await resolveRetryPolicy().retryOn(ctx(status))).toBe(true);
    });

    it.each([200, 201, 400, 401, 403, 404, 422])("does not retry %d by default", async (status) => {
      expect(await resolveRetryPolicy().retryOn(ctx(status))).toBe(false);
    });

    it("accepts an explicit status list", async () => {
      const p = resolveRetryPolicy({ retryOn: [418] });
      expect(await p.retryOn(ctx(418))).toBe(true);
      expect(await p.retryOn(ctx(503))).toBe(false);
    });

    it("accepts a predicate", async () => {
      const p = resolveRetryPolicy({ retryOn: (c) => c.attempt < 2 });
      expect(await p.retryOn(ctx(200))).toBe(true);
    });

    it("does not retry when there is no response to inspect", async () => {
      const p = resolveRetryPolicy();
      expect(await p.retryOn({ attempt: 1, url: "u", method: "GET" })).toBe(false);
    });
  });
});

describe("delayForAttempt", () => {
  it("doubles each attempt when exponential", () => {
    const p = resolveRetryPolicy({ delayMs: 100, backoff: "exponential" });
    expect(delayForAttempt(p, 1)).toBe(100);
    expect(delayForAttempt(p, 2)).toBe(200);
    expect(delayForAttempt(p, 3)).toBe(400);
  });

  it("stays flat when fixed", () => {
    const p = resolveRetryPolicy({ delayMs: 100, backoff: "fixed" });
    expect(delayForAttempt(p, 1)).toBe(100);
    expect(delayForAttempt(p, 4)).toBe(100);
  });

  it("clamps to maxDelayMs", () => {
    const p = resolveRetryPolicy({ delayMs: 1000, maxDelayMs: 2500 });
    expect(delayForAttempt(p, 10)).toBe(2500);
  });
});

describe("retryAfterMs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("reads a delay given in seconds", () => {
    const r = new Response(null, { status: 429, headers: { "Retry-After": "12" } });
    expect(retryAfterMs(r)).toBe(12_000);
  });

  it("reads a delay given as an HTTP date", () => {
    const r = new Response(null, {
      status: 503,
      headers: { "Retry-After": "Thu, 01 Jan 2026 00:00:30 GMT" },
    });
    expect(retryAfterMs(r)).toBe(30_000);
  });

  it("never reports a negative wait for a date in the past", () => {
    const r = new Response(null, {
      status: 503,
      headers: { "Retry-After": "Thu, 01 Jan 2020 00:00:00 GMT" },
    });
    expect(retryAfterMs(r)).toBe(0);
  });

  it("returns undefined when absent, unparseable, or there is no response", () => {
    expect(retryAfterMs(new Response(null))).toBeUndefined();
    expect(
      retryAfterMs(new Response(null, { headers: { "Retry-After": "soonish" } })),
    ).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });
});

describe("sleep", () => {
  it("resolves immediately for a non-positive delay", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
    await expect(sleep(-5)).resolves.toBeUndefined();
  });

  it("rejects at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(sleep(1000, controller.signal)).rejects.toThrow("gone");
  });

  it("rejects when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  });

  it("resolves after the delay elapses", async () => {
    vi.useFakeTimers();
    try {
      const pending = sleep(500);
      vi.advanceTimersByTime(500);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
