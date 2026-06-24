import { defineConfig } from "tsdown";

// @facet/parity is a private dev/test harness; this config exists only so the
// workspace-wide `build` is uniform. The package is never published.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
