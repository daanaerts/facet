import type { CapabilityDef } from "./capability";
import type { SurfaceKind } from "./surface";

/** The single map every surface reads: `capabilityId → definition`. */
export class Registry {
  #map = new Map<string, CapabilityDef>();

  register(def: CapabilityDef): void {
    if (this.#map.has(def.id)) {
      throw new Error(`duplicate capability id: ${def.id}`);
    }
    this.#map.set(def.id, def);
  }

  get(id: string): CapabilityDef | undefined {
    return this.#map.get(id);
  }

  has(id: string): boolean {
    return this.#map.has(id);
  }

  /** All capabilities, id-sorted for stable output. */
  all(): CapabilityDef[] {
    return [...this.#map.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Enabled capabilities that project onto a given surface. */
  forSurface(surface: SurfaceKind): CapabilityDef[] {
    return this.all().filter((d) => d.enabled && d.surfaces.includes(surface));
  }

  get size(): number {
    return this.#map.size;
  }
}
