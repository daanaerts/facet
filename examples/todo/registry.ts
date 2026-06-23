import { Registry } from "@facet/core";
import todosAdd from "./capabilities/todos.add.cap";
import todosComplete from "./capabilities/todos.complete.cap";
import todosList from "./capabilities/todos.list.cap";
import todosRemove from "./capabilities/todos.remove.cap";
import todosWatch from "./capabilities/todos.watch.cap";

/**
 * The todo registry — the five capabilities registered into one map every surface reads. The entrypoints
 * (serve / cli / mcp), the agent driver, and the tests all build from this one function, so a new
 * `todos.*.cap.ts` lights up on every surface the moment it is added here (a real host would discover these
 * by glob via `discoverCapabilities`; the example wires them explicitly so the set is legible at a glance).
 */
export function todoRegistry(): Registry {
  const registry = new Registry();
  for (const def of [todosAdd, todosList, todosComplete, todosRemove, todosWatch]) {
    registry.register(def);
  }
  return registry;
}
