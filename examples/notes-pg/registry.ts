import { Registry } from "@facet/core";
import notesAdd from "./capabilities/notes.add.cap";
import notesList from "./capabilities/notes.list.cap";

/** The notes registry — the two capabilities every entrypoint and test builds from. */
export function notesRegistry(): Registry {
  const registry = new Registry();
  for (const def of [notesAdd, notesList]) registry.register(def);
  return registry;
}
