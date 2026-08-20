import { defineConfig } from "tsup";

export default defineConfig({
  // Two entry points: the core, and the OAuth support as a subpath, so a
  // consumer who does not need it never pays for it.
  entry: ["src/index.ts", "src/oauth/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: "es2022",
});
