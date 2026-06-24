import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { CapabilityDef } from "./capability";
import { FacetError } from "./errors";
import { Registry } from "./registry";

/**
 * Build the registry by walking the given roots for `*.cap.ts` files and importing their default exports. A
 * new capability file "just appears" in the registry — no hand-maintained list.
 *
 * RUNTIME-PURE DISCOVERY: this is the one place the engine touches the filesystem, and it must stay
 * runtime-agnostic — the published package runs on Bun, Node 22+ and Deno. So discovery uses `node:fs`'s
 * recursive `readdir` (supported on all three: Bun + Node ≥ 18.17 / 20 + Deno's `node:` compat) and a plain
 * suffix match, NOT `Bun.Glob`. `Bun.Glob` was the single Bun-only leak in the engine; replacing it with a
 * `node:fs` walk is what lets `@facet/core` import clean off Bun.
 *
 * The walk is a flat `readdir(root, { recursive: true })` returning every descendant path relative to the
 * root — equivalent to the old recursive `*.cap.ts` glob, minus the glob dependency. Paths are made absolute
 * and converted to a `file://` URL before `import()` so a dynamic import resolves identically on every
 * runtime (Node rejects a bare absolute path on Windows; a URL is portable everywhere).
 *
 * CARVE NOTE: Moral Fabric's discovery tagged each capability with an `appId` derived from its `apps/<id>/`
 * path (for install-gating). That coupling is gone — discovery here is pure walk + default-export, with no
 * notion of an owning app.
 */
export async function discoverCapabilities(
  roots: string | string[] = "examples",
  cwd: string = process.cwd(),
): Promise<Registry> {
  const registry = new Registry();
  const dirs = Array.isArray(roots) ? roots : [roots];
  const seen = new Set<string>();

  for (const dir of dirs) {
    for (const file of await capabilityFiles(dir, cwd)) {
      if (seen.has(file)) continue;
      seen.add(file);

      const mod = (await import(pathToFileURL(file).href)) as { default?: CapabilityDef };
      const def = mod.default;
      if (!def || typeof def.id !== "string") {
        throw new FacetError(
          "validation",
          `capability file is missing a default-exported defineCapability(): ${file}`,
          400,
          { file },
        );
      }
      registry.register(def);
    }
  }

  return registry;
}

/**
 * Recursively list the `*.cap.ts` files under `${cwd}/${dir}`, as absolute paths, sorted for a deterministic
 * registration order (the OS gives no ordering guarantee; sorting keeps "which duplicate id wins" stable).
 * A missing root is not an error — an absent example/plugin dir simply contributes nothing, matching the old
 * glob's "no matches ⇒ empty" behavior rather than throwing.
 */
async function capabilityFiles(dir: string, cwd: string): Promise<string[]> {
  const root = `${cwd}/${dir}`;
  let entries: string[];
  try {
    // `recursive: true` returns every descendant path relative to `root` (files and dirs). One readdir per
    // root walks the whole subtree, so we filter to capability files in a single pass — no manual recursion.
    entries = await readdir(root, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((rel) => rel.endsWith(".cap.ts"))
    .map((rel) => `${root}/${rel}`)
    .sort();
}
