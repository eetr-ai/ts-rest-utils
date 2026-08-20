import { describe, expect, it } from "vitest";

import * as api from "./index.js";

describe("package entry point", () => {
  it("is importable", () => {
    expect(api).toBeTypeOf("object");
  });

  it("has no runtime exports yet", () => {
    // `HttpMethod` is a type, so it erases at build time. This pins the
    // placeholder state: when the real surface lands, this test is replaced
    // rather than quietly passing against a half-exported module.
    expect(Object.keys(api)).toEqual([]);
  });
});
