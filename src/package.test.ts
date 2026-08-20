import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as api from "./index.js";

describe("public surface", () => {
  it("exports exactly the documented runtime values", () => {
    expect(new Set(Object.keys(api))).toEqual(
      new Set([
        "APIResponse",
        "ApiResponse",
        "HttpError",
        "NetworkError",
        "RestClient",
        "RestError",
        "TimeoutError",
        "buildUrl",
        "configure",
        "consoleLogger",
        "createEndpoints",
        "decodeBody",
        "deleteApi",
        "encodeBody",
        "getApi",
        "getDefaultClient",
        "noopLogger",
        "patchApi",
        "postApi",
        "putApi",
        "redactHeaders",
        "redactUrl",
        "resetDefaultClient",
        "resolveBase",
        "withQuery",
      ]),
    );
  });

  it("keeps APIResponse as an alias of ApiResponse", () => {
    expect(api.APIResponse).toBe(api.ApiResponse);
  });
});

describe("packaging constraints", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it("has no runtime dependencies", () => {
    // The whole point of the authProvider hook is that no credential SDK ever
    // needs to ship here. If this fails, something was pulled in that should
    // have stayed a README recipe.
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });
});

describe("genericity", () => {
  const sources = [
    "client.ts",
    "response.ts",
    "errors.ts",
    "url.ts",
    "body.ts",
    "retry.ts",
    "logger.ts",
    "compat.ts",
    "index.ts",
  ].map((name) => readFileSync(new URL(name, import.meta.url), "utf8"));

  it.each([
    ["a project header prefix", /x-eetr/i],
    ["a project environment variable", /\bEETR_/],
    ["a product name", /whippedup/i],
    ["a credential vendor", /firebase|google-auth|googleapis/i],
  ])("contains no %s", (_label, pattern) => {
    // This library is meant for anyone calling an API from TypeScript. Every
    // application-specific concern belongs behind authProvider or in a README
    // recipe, and this is what keeps that true as the code changes.
    const offenders = sources.filter((source) => pattern.test(source));
    expect(offenders).toHaveLength(0);
  });
});
