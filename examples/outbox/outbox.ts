/**
 * The local outbox LOG — the record of what was sent, separate from the external provider that sent it. The
 * connectors (see `connectors.ts`) perform the irreversible external act (deliver the email, open the issue);
 * the handler then appends a row HERE so `messages.list` / `outbox.tail` have something to read regardless of
 * which connector is active. Plain in-memory, so the example is runtime-pure and hermetic; a real host swaps
 * this for a table behind the same API.
 */

export interface OutboxEntry {
  id: string;
  kind: "email" | "issue";
  /** Who/where it went — an email recipient or a repo. */
  target: string;
  /** A one-line summary — the email subject or the issue title. */
  summary: string;
  /** Which connector delivered it: `"memory"` (dev) | `"resend"` | `"github"`. */
  provider: string;
  createdAt: string;
}

const entries: OutboxEntry[] = [];
let seq = 0;
let clock: () => string = () => new Date().toISOString();

export const outbox = {
  /** Record a sent item and return the stored entry (with its assigned id + timestamp). */
  append(entry: Omit<OutboxEntry, "id" | "createdAt">): OutboxEntry {
    seq += 1;
    const stored: OutboxEntry = { ...entry, id: `out_${seq}`, createdAt: clock() };
    entries.push(stored);
    return stored;
  },
  /** The whole log, oldest-first — what `messages.list` and `outbox.tail` walk over. */
  list(): OutboxEntry[] {
    return [...entries];
  },
  /** Test helper — reset to seed state, optionally pinning the clock so `createdAt` is reproducible. */
  reset(c?: () => string): void {
    clock = c ?? (() => new Date().toISOString());
    entries.length = 0;
    seq = 0;
    seed();
  },
};

function seed(): void {
  outbox.append({
    kind: "email",
    target: "ops@acme.example",
    summary: "Welcome aboard",
    provider: "memory",
  });
}

seed();
