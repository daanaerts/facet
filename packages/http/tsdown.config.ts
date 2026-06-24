import { defineConfig } from "tsdown";

export default defineConfig({
  // Two entries: the framework-agnostic fetch handler (index) and the optional
  // Elysia wrapper (elysia), so `@facet/http` pulls in no web framework and
  // `@facet/http/elysia` is the only path that touches the optional `elysia` peer.
  entry: { index: "src/index.ts", elysia: "src/app.ts" },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
