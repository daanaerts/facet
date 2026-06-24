import { defineCapability } from "@facet/core";
import { z } from "zod";
import { type IssueConnector, useConnector } from "../connectors";
import { outbox } from "../outbox";

/**
 * `issues.open` — a write that creates external state via a DIFFERENT connector (`"github"`), reached the same
 * way `email.send` reaches `"email"`. It is `reversible: true` (an issue can be closed), in contrast to the
 * irreversible email send — the same `connector` port, two different reversibility postures, so a surface can
 * calibrate its confirmation copy per capability. Still confirmation-gated (a write), still idempotent.
 */
export default defineCapability({
  id: "issues.open",
  summary: "Open a GitHub issue through the configured issue connector.",
  input: z.object({
    repo: z.string().min(1).describe('Repository in "owner/name" form.'),
    title: z.string().min(1).describe("Issue title."),
    body: z.string().min(1).describe("Issue body."),
  }),
  output: z.object({
    id: z.string(),
    kind: z.enum(["email", "issue"]),
    target: z.string(),
    summary: z.string(),
    provider: z.string(),
    createdAt: z.string(),
  }),
  scopes: ["outbox:send"],
  risk: "write",
  reversible: true,
  idempotent: true,
  handler: async (input, ctx) => {
    const issues = useConnector<IssueConnector>(ctx, "github");
    const opened = await issues.open({ repo: input.repo, title: input.title, body: input.body });
    const entry = outbox.append({
      kind: "issue",
      target: input.repo,
      summary: input.title,
      provider: opened.provider,
    });
    ctx.audit("issue.opened", { id: entry.id, repo: input.repo, provider: opened.provider });
    return entry;
  },
});
