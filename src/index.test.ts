import { describe, expect, it } from "vitest";

import * as api from "./index.js";

/**
 * A smoke test over the public surface. The behavioural suite for each module
 * lands in the change that follows; this only pins what the entry point
 * exports, so an accidental removal or rename shows up as a failing test rather
 * than as a broken import in someone else's project.
 */
describe("public surface", () => {
  const expected = [
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
  ];

  it("exports exactly the documented runtime values", () => {
    expect(new Set(Object.keys(api))).toEqual(new Set(expected));
  });

  it("constructs a client", () => {
    const client = new api.RestClient({ baseUrl: "https://api.example.com" });
    expect(client.resolveUrl("/users")).toBe("https://api.example.com/users");
  });

  it("keeps APIResponse as an alias of ApiResponse", () => {
    expect(api.APIResponse).toBe(api.ApiResponse);
  });
});
