import type { Context } from "@facet/core";
import { withClaims } from "@facet/postgres";
import { sql } from "drizzle-orm";
import { db } from "./db";

/**
 * The notes store — every method runs through {@link withClaims}, which opens a transaction, adopts the
 * non-owner `notes_app` role, and pushes the caller's `workspaceId` claim into the `notes.workspace` GUC the
 * RLS policy reads. So the queries below carry NO tenant `WHERE` clause: the database adds it. This is the
 * RLS-as-defense-in-depth point made concrete — the capability authorized the *verb* in `execute()`; the row
 * scoping happens here, in Postgres.
 */
const RLS = { role: "notes_app", settings: { workspaceId: "notes.workspace" } } as const;

export interface Note {
  id: number;
  workspace: string;
  body: string;
}

/** Normalize Bun-SQL / node-postgres result shapes into a plain row array. */
function rowsOf(res: unknown): Record<string, unknown>[] {
  if (Array.isArray(res)) return res as Record<string, unknown>[];
  if (res && typeof res === "object" && "rows" in res) {
    return ((res as { rows?: Record<string, unknown>[] }).rows ?? []) as Record<string, unknown>[];
  }
  return [];
}

export const store = {
  /** Insert a note into the caller's workspace and return it. `WITH CHECK` makes the workspace match enforced. */
  async add(ctx: Context, body: string): Promise<Note> {
    const workspace = String(ctx.claims?.workspaceId);
    return withClaims(db(), ctx, RLS, async (tx) => {
      const res = await tx.execute(
        sql`INSERT INTO notes (workspace, body) VALUES (${workspace}, ${body})
            RETURNING id, workspace, body`,
      );
      return rowsOf(res)[0] as unknown as Note;
    });
  },

  /** Every note the caller may see, oldest-first. No `WHERE workspace = …` — the RLS policy supplies it. */
  async list(ctx: Context): Promise<Note[]> {
    return withClaims(db(), ctx, RLS, async (tx) => {
      const res = await tx.execute(sql`SELECT id, workspace, body FROM notes ORDER BY id`);
      return rowsOf(res) as unknown as Note[];
    });
  },
};
