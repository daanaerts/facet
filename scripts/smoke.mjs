// Cross-runtime publish smoke: proves the BUILT @facet/core dist imports and runs on a plain
// Node 22 and on Deno (not just Bun). Dependency-free on purpose — it hand-rolls a Standard
// Schema validator so it needs nothing but @facet/core itself, resolved through the package
// `exports` map (Node/Deno match the `import` condition → ./dist/index.js).
//
// Run after `bun run build`:  node scripts/smoke.mjs   /   deno run -A --node-modules-dir scripts/smoke.mjs
import { buildContext, defineCapability, execute, Registry } from "@facet/core";

/** A pass-through Standard Schema — validation is exercised by execute(), no validator dep needed. */
const passthrough = {
  "~standard": { version: 1, vendor: "facet-smoke", validate: (value) => ({ value }) },
};

const ping = defineCapability({
  id: "smoke.ping",
  summary: "Smoke-test capability.",
  input: passthrough,
  output: passthrough,
  handler: async () => ({ ok: true }),
});

const registry = new Registry();
registry.register(ping);

const ctx = buildContext({ actor: { kind: "service" }, scopes: [], surface: "cli" });
const out = await execute(registry, "smoke.ping", {}, ctx);

if (!out || out.ok !== true) {
  throw new Error(`[smoke] FAIL — unexpected result: ${JSON.stringify(out)}`);
}
console.log("[smoke] OK — @facet/core imported from built dist and execute() ran. Result:", out);
