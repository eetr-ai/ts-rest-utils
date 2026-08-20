import { describe, expect, it } from "vitest";

import { HttpError } from "./errors.js";
import { APIResponse, ApiResponse } from "./response.js";

function make<T>(status: number, body: T) {
  return new ApiResponse<T>({
    status,
    bodyType: "application/json",
    body,
    url: "https://api.test/thing",
    method: "GET",
  });
}

describe("ApiResponse", () => {
  describe("ok", () => {
    it.each([200, 201, 204, 299])("treats %d as successful", (status) => {
      expect(make(status, null).ok).toBe(true);
    });

    it.each([100, 199, 300, 301, 400, 404, 500])("treats %d as unsuccessful", (status) => {
      expect(make(status, null).ok).toBe(false);
    });
  });

  describe("getOrDefault", () => {
    it("returns the body on success", () => {
      expect(make(200, "value").getOrDefault("fallback")).toBe("value");
    });

    it("returns the default on failure", () => {
      expect(make(500, "value").getOrDefault("fallback")).toBe("fallback");
    });

    it("honours an explicit success status instead of the 2xx range", () => {
      // 200 is in the 2xx range but is not the 201 the caller required.
      expect(make(200, "value").getOrDefault("fallback", 201)).toBe("fallback");
      expect(make(201, "value").getOrDefault("fallback", 201)).toBe("value");
    });

    it("returns a falsy body rather than the default", () => {
      // The check is on status, not on truthiness — an empty array is a
      // legitimate successful result and must not be swapped for the default.
      expect(make(200, [] as string[]).getOrDefault(["fallback"])).toEqual([]);
      expect(make(200, 0).getOrDefault(99)).toBe(0);
      expect(make(200, false).getOrDefault(true)).toBe(false);
    });
  });

  describe("getOrNull", () => {
    it("returns the body on success and null on failure", () => {
      expect(make(200, { a: 1 }).getOrNull()).toEqual({ a: 1 });
      expect(make(404, { a: 1 }).getOrNull()).toBeNull();
    });

    it("honours an explicit success status", () => {
      expect(make(202, "v").getOrNull(201)).toBeNull();
    });
  });

  describe("getOrThrow", () => {
    it("returns the body on success", () => {
      expect(make(200, "value").getOrThrow()).toBe("value");
    });

    it("throws the caller's own throwable when given one", () => {
      const boom = new Error("could not load the thing");
      expect(() => make(500, null).getOrThrow(boom)).toThrow(boom);
    });

    it("throws a non-Error throwable unchanged", () => {
      // The clients this replaces threw strings; passing one through keeps
      // those call sites behaving as they did.
      expect(() => make(500, null).getOrThrow("plain string")).toThrow("plain string");
    });

    it("throws an HttpError carrying status, body, and request details by default", () => {
      const response = make(503, { error: "unavailable" });
      try {
        response.getOrThrow();
        expect.unreachable("should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(HttpError);
        const http = error as HttpError;
        expect(http.status).toBe(503);
        expect(http.body).toEqual({ error: "unavailable" });
        expect(http.method).toBe("GET");
        expect(http.url).toBe("https://api.test/thing");
      }
    });

    it("honours an explicit success status", () => {
      expect(() => make(200, "v").getOrThrow(undefined, 201)).toThrow(HttpError);
      expect(make(201, "v").getOrThrow(undefined, 201)).toBe("v");
    });
  });

  it("defaults headers to an empty set when none are supplied", () => {
    const names: string[] = [];
    make(200, null).headers.forEach((_value, name) => names.push(name));
    expect(names).toEqual([]);
  });

  it("exposes the originating Response when built from one", () => {
    const raw = new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const wrapped = new ApiResponse({
      status: raw.status,
      bodyType: "application/json",
      body: {},
      headers: raw.headers,
      raw,
    });
    expect(wrapped.raw).toBe(raw);
    expect(wrapped.headers.get("Content-Type")).toBe("application/json");
  });

  it("is also exported under the APIResponse spelling", () => {
    expect(APIResponse).toBe(ApiResponse);
  });
});
