/**
 * A multi-tenant "projects" domain — the world the capabilities act on, partitioned BY WORKSPACE. The
 * framework knows NOTHING about a workspace: every store method takes the `workspace` as its first argument,
 * and the capabilities pass `requireClaim<string>(ctx, "workspace")` into it (see the `capabilities/`). Tenancy
 * is the HOST's concern, expressed as a claim the handler threads into a workspace-scoped store — exactly the
 * pattern `docs/quickstart.md` documents. Not one capability or surface learns what a tenant is.
 *
 * It is a plain in-memory `Map`, so the example is runtime-pure (Bun / Node 22+ / Deno, no `bun:sqlite`) and
 * needs zero setup. A real host swaps this for Postgres with a `workspace_id` column (and ideally row-level
 * security) behind this SAME API — the capabilities never change. That swap is the "port + real adapter"
 * story; for THIS example the real adapter we ship is the AUTH provider (see `auth.ts`), since tenancy — not
 * persistence — is the axis this example teaches.
 */

export interface Project {
  id: string;
  name: string;
  /** The workspace that owns this project. Stamped from the caller's `workspace` claim, never from input. */
  workspace: string;
  /** ISO timestamp the project was created, so a list is stably orderable oldest-first. */
  createdAt: string;
}

/** Every workspace's projects, oldest-first. A workspace with no projects simply has no entry. */
const byWorkspace = new Map<string, Project[]>();

/** A process-wide monotonic counter behind `proj_<n>`, so ids are globally unique and deterministic. */
let seq = 0;

/** A swappable clock so tests can pin `createdAt` (cross-surface parity compares whole outputs). */
let clock: () => string = () => new Date().toISOString();

function insert(workspace: string, name: string): Project {
  seq += 1;
  const project: Project = { id: `proj_${seq}`, name, workspace, createdAt: clock() };
  const list = byWorkspace.get(workspace) ?? [];
  list.push(project);
  byWorkspace.set(workspace, list);
  return project;
}

/**
 * Seed two tenants so isolation is visible immediately: `acme` owns two projects, `globex` owns one. With the
 * global counter that is `proj_1`/`proj_2` (acme) and `proj_3` (globex); the next create anywhere is `proj_4`.
 */
function seed(): void {
  insert("acme", "Website Redesign");
  insert("acme", "Q3 Roadmap");
  insert("globex", "Launch Plan");
}

export const store = {
  /** Every project in ONE workspace, oldest-first. A caller can only ever see its own workspace's projects. */
  list(workspace: string): Project[] {
    return [...(byWorkspace.get(workspace) ?? [])];
  },
  /** Create a project in a workspace and return it. */
  create(workspace: string, name: string): Project {
    return insert(workspace, name);
  },
  /** One project by id WITHIN a workspace, or `undefined`. A project in another workspace reads as absent. */
  get(workspace: string, id: string): Project | undefined {
    return byWorkspace.get(workspace)?.find((p) => p.id === id);
  },
  /**
   * Remove a project FROM a workspace; returns whether a row was actually deleted. Crucially, removing an id
   * that lives in a DIFFERENT workspace returns `false` — so a caller can never delete across the tenant
   * boundary, and the capability renders that miss as a clean `not_found` (never "you may not touch that").
   */
  remove(workspace: string, id: string): boolean {
    const list = byWorkspace.get(workspace);
    if (!list) return false;
    const i = list.findIndex((p) => p.id === id);
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  },
  /** Test helper — reset to seed state, optionally pinning the clock so `createdAt` is reproducible. */
  reset(c?: () => string): void {
    clock = c ?? (() => new Date().toISOString());
    byWorkspace.clear();
    seq = 0;
    seed();
  },
};

// A fresh process starts seeded so there is something to poke at on every surface immediately.
seed();
