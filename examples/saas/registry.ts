import { Registry } from "@facet/core";
import projectsCreate from "./capabilities/projects.create.cap";
import projectsDelete from "./capabilities/projects.delete.cap";
import projectsList from "./capabilities/projects.list.cap";
import projectsWatch from "./capabilities/projects.watch.cap";

/**
 * The multi-tenant registry — the four capabilities every surface reads. The entrypoints (serve / cli / mcp),
 * the agent driver, and the tests all build from this one function, so a new `projects.*.cap.ts` lights up on
 * every surface the moment it is added here. A real host would discover these by glob via
 * `discoverCapabilities`; the example wires them explicitly so the set is legible at a glance.
 */
export function saasRegistry(): Registry {
  const registry = new Registry();
  for (const def of [projectsList, projectsCreate, projectsDelete, projectsWatch]) {
    registry.register(def);
  }
  return registry;
}
