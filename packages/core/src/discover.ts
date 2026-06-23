import { Glob } from "bun";
import type { CapabilityDef } from "./capability";
import { Registry } from "./registry";

/**
 * Build the registry by globbing for `*.cap.ts` files and importing their default exports. A new capability
 * file "just appears" in the registry — no hand-maintained list.
 *
 * CARVE NOTE: Moral Fabric's discovery tagged each capability with an `appId` derived from its `apps/<id>/`
 * path (for install-gating). That coupling is gone — discovery here is pure glob + default-export, with no
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
    const glob = new Glob(`${dir}/**/*.cap.ts`);
    for await (const file of glob.scan({ cwd, absolute: true, onlyFiles: true })) {
      if (seen.has(file)) continue;
      seen.add(file);

      const mod = (await import(file)) as { default?: CapabilityDef };
      const def = mod.default;
      if (!def || typeof def.id !== "string") {
        throw new Error(
          `capability file is missing a default-exported defineCapability(): ${file}`,
        );
      }
      registry.register(def);
    }
  }

  return registry;
}
