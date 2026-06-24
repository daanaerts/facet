# Facet — Validation Plan: "Tested by 20 Developers"

**Definition of done:** 20 developers paste a one-line prompt into their agent, reach a
running multi-surface app, hit the confirmation/security wedge, and give structured
feedback — enough of them showing the buy signal to justify building further (incl. hosting).

This is the **private design-partner phase**. No public HN launch yet — that comes *after*
this gate passes and the onboarding self-serves reliably.

---

## Positioning lock (decided)

- ❌ Don't pitch **"humans and agents get the exact same capabilities."** (Note: this line is
  NOT in the repo — the README already says "projections of the same capability," and
  `docs/CONFIRMATION.md` warns against the trap. The discipline is about the *new* public copy
  — facet.dev, tagline, the prompt's framing — not a purge of existing files.) The "exact same"
  framing makes us sound like a late, smaller clone of Builder's `agent-native`.
- ✅ Lead with **divergence-correctness as a security property**:
  > *Define a capability once. Facet enforces it correctly on every surface — including
  > refusing to let an agent run a destructive action without a human in the loop.*
- **Why this wins:** the funded incumbent (`BuilderIO/agent-native`, MIT, ~1.9k stars) leaves
  writes **ungated over MCP** (`build-server.ts:1463-1471` never consults `needsApproval`),
  has **no read/write/destructive taxonomy** (approvals are opt-in, default off), and **can't
  stream actions at all** (`run: => Promise<T> | T`). Our single `execute.ts:59` chokepoint
  makes their MCP-bypass hole structurally impossible. That's a must-have framing, not a
  nice-to-have one.

## The activation mechanic = the homepage

A single copy-paste prompt. The dev's **own agent** builds the app → the dev talks to the app
**through** their agent (MCP) → then watches the **confirmation gate fire** when they ask the
agent to do something destructive. The onboarding *is* an agent — which is the thesis itself.
The whole plan orbits making that one prompt reliable.

---

## Track A — Lock the wedge & demo  *(Week 1, ~1–2 days; unblocks B & C)*

- [ ] Write the one-sentence public pitch in the security framing (the README's "projections of
      the same capability" is already correct; the job is the new site/tagline, not editing the repo).
- [ ] Choose the canonical demo app: small, real, with **one destructive write** (e.g. refund /
      delete project / send invoice) and **one streaming op** (e.g. export / summarize).
- [ ] Write the **wedge-moment script**: GUI click does it instantly; agent over MCP must
      confirm; "ask your agent to delete X" → it returns `confirmation_required`. This is the
      artifact every dev gets pointed at.
- [ ] Pick the beachhead persona: builders shipping agent-accessible apps that touch
      **money / infra / irreversible writes** (where ungated agent writes are unacceptable).
- [ ] Lock v0 scope: confirmation wedge **mandatory**, streaming op **strong bonus**,
      pagination / partial-updates / optimistic writes **explicitly OUT** (unimplemented — do
      not claim them).

## Track B — Make the code testable  *(the long pole — scoped 2026-06-24)*

Three workstreams. **B1 (publish) is the hard prerequisite** for everything downstream; B2/B3
produce the scaffold the one-line prompt reproduces. Architect lens applied — TAM/contract notes inline.

Key finding from scoping: **the engine source is already runtime-pure** (every `Bun.*` in
`packages/*/src` is a comment; discovery/validation/idempotency are behind ports). So Bun-excision
is a *demo-host + build/publish* job, **not** a library-engine rewrite. Good news.

### B0 · Security — do now
- [ ] **Rotate the Anthropic key in `facet-demo/.env`** (`sk-ant-api03-…`, readable in the dir;
      gitignored so likely uncommitted, but scrub before this becomes a shared seed).

### B1 · Publish `@facet/*` to npm  *(0 of 7 packages are publishable today)*
All are `private:true`, `0.0.0`, no build, `exports` → raw `./src/index.ts`; `attw` resolves only
under a bundler (💀 on node16/node10). `publint` passing is misleading. Fixes, most-blocking first:
- [ ] Add a build emitting `dist/` JS + `.d.ts` per package — recommend **tsc** (ESM + declarations,
      smallest/standard; not a bundler). `tsconfig.base.json` is `noEmit` today.
- [ ] Add `.js` extensions to extensionless relative imports (e.g. `core/src/index.ts:1
      from "./build-context"`) so node16 resolution works under plain tsc — this is what flips attw 💀→🟢.
- [ ] Repoint `exports` at built files: `{ ".": { "types": "./dist/index.d.ts", "import":
      "./dist/index.js" } }`; add `files: ["dist","README.md","LICENSE"]`.
- [ ] Remove `private:true`; add `publishConfig:{access:"public"}` (scoped pkgs default restricted).
- [ ] Bump off `0.0.0`; rewrite `workspace:*` cross-deps → real semver on publish; add **changesets**
      (no release pipeline exists).
- [ ] Per-package `description` / `license:"MIT"` / `repository` / README (all 7 missing every one).
- [ ] Keep **`@facet/parity` private** — it's a test harness, not a surface. Don't publish it.
- [ ] **Architect call — Elysia subpath (contract; do before v0):** `@facet/http`'s entry re-exports
      `app.ts` which statically `import { Elysia }`, forcing Elysia onto every consumer and
      contradicting "the portable fetch handler has no Elysia dep." Move `createHttpApp` →
      `@facet/http/elysia`; keep `createFetchHandler` Elysia-free on the main entry. Freeze this shape
      *before* adopters exist (cheapest contract = the one never made).
- [ ] `@facet/cli`: add `bin` + shebang if it runs as `facet`, else document it as a library.
- [ ] Add the **Node 22 + Bun CI matrix** that *proves* runtime-purity — README admits it's deferred.
      "Runs on Node" must be enforced by a test, not asserted (a non-negotiable).

### B2 · De-Bun the scaffold app  *(demo-host job; engine is already clean)*
For whichever app becomes the seed (see decision below):
- [ ] Default the scaffold to an **in-memory store** — no `bun:sqlite`, no native build, no flags;
      the wedge needs no persistence. SQLite (`node:sqlite`/`better-sqlite3`) = documented upgrade.
- [ ] Swap Bun entrypoint APIs: `Bun.serve` → `@hono/node-server`; `Bun.argv` → `process.argv`;
      `import.meta.dir` → `import.meta.dirname`; drop the `#!/usr/bin/env bun` shebang.
- [ ] Run `.ts` on Node via **tsx** (reliable, one devDep) over `--experimental-strip-types`
      (zero-dep but version-fragile). Drop `@types/bun` / `types:["bun"]`; add `@types/node`.
- [ ] Tests → `node:test`/vitest; replace the bunfig `preload` with the runner's setup hook.
- [ ] (The Next.js `web/` GUI is already Node-portable — only `serve.ts` changes.)

### B3 · Build the scaffold + MCP connect  *(nothing exists today)*
No `create-facet` anywhere; `facet-fleet/template` is a headless eval harness with no surfaces.
- [ ] Build `npm create facet` emitting: `registry.ts`; `capabilities/` (≥1 read, ≥1 confirm-gated
      destructive, ideally 1 streaming); `serve.ts` + the **generic registry-driven `console.html`
      GUI** (domain-agnostic — drops onto any registry); `mcp.ts`; `cli.ts`; Node `package.json` with
      real `@facet/*` deps (needs B1).
- [ ] **Emit the MCP-client connect config** (`.mcp.json` / `claude_desktop_config.json` snippet) —
      currently MISSING from every example. The wedge moment depends on a client actually connecting.
- [ ] `check` green on the scaffold output.
- [ ] Document what's intentionally NOT in v0 (pagination / partial-updates / optimistic writes).

### Open decision — the scaffold seed domain
- [ ] **Pick the canonical domain.** Options: `examples/todo` (has the generic GUI, but "delete a
      todo" is low-stakes) · `examples/saas` (projects/create/delete = infra stakes + multi-tenant,
      but no GUI) · **hybrid (recommended): a small projects/deploys domain + todo's registry-driven
      `console.html`** — since the GUI is domain-agnostic, domain and GUI are decoupled, so you get
      beachhead stakes *and* a clickable wedge. `facet-demo` (Next.js + copilot) stays the linked
      full-featured reference, not the first-run default (heavier: extra deps + needs an API key).

## Track C — One-line prompt + landing  *(Week 2–3, depends on B)*

- [ ] Author the prompt: pastes into Claude Code (and ideally claude.ai), tells the agent to
      scaffold + run the app + connect the MCP surface, then walks to the wedge moment.
- [ ] Decide delivery: prompt + stable hosted guide the agent fetches (`llms.txt` / `START.md` /
      Claude Code skill). Default: prompt referencing a hosted guide + `npm create facet`.
- [ ] Build `facet.dev` = the prompt in a copy box + a 30-sec Loom of the wedge moment + one
      "what is this" paragraph in the new framing. Nothing else.
- [ ] **RELIABILITY GATE:** run the prompt **10× from clean contexts**. Must reach a running
      multi-surface app **≥8/10** before any dev sees it. No reliable prompt = no data.
- [ ] Add a fake **"Deploy / host this"** button (landing or post-scaffold output) to capture
      hosting intent → hypothesis-2 signal.

## Track D — Instrumentation & feedback  *(Week 2–3, parallel with C)*

- [ ] Define "activated" = running app, both surfaces, confirmation gate fired. Decide how you
      detect it (post-scaffold ping / opt-in telemetry / or just ask).
- [ ] Write the feedback form + 20-min interview script. Core questions:
  - Did you reach a running app? Where did you get stuck?
  - When you asked your agent to do something destructive, what happened — and did it matter to you?
  - Would you build a real project on this? Why / why not?
  - (watch for unprompted) did they ask about hosting/deploy?
  - What would make you switch from Builder's agent-native / rolling your own MCP?
- [ ] Tracking sheet: 20 devs × (recruited / scaffolded / activated / wedge-felt / buy-signal / hosting-ask).

## Track E — Recruit 20  *(source Week 1, sessions Week 3–4)*

- [ ] Source list of agent-builders: MCP Discord, AI-eng communities, your network, Bluesky/X
      AI-eng, people already shipping MCP servers. Private outreach, not a public post.
- [ ] Write the recruit DM (short: "30 min — build a multi-surface app by pasting one prompt,
      tell me where it breaks").
- [ ] Sequence in waves: **3–5 LIVE watch sessions first** (find the cliff) → fix → **~15 async
      self-serve** (activation rate + breadth). Don't batch all 20 — let wave-1 fixes improve wave-2.

## Track F — Decision gate  *(Week 4–5)*

Pre-commit these thresholds **now** so they aren't rationalized later:

- [ ] **Activation ≥ 50%** of starters reach a running multi-surface app via the prompt.
- [ ] **≥ 8 / 20** hit the wedge moment and describe the value back in their own words.
- [ ] **≥ 5 / 20** say they'd use it for a real project.
- [ ] **≥ 3** unprompted "how do I host/deploy this?" (hypothesis-2 signal).
- [ ] **KILL signal:** if ≥ half say "Builder's agent-native is good enough," stop and rethink
      the wedge/beachhead before spending more.

**Decision:** GO (build toward hosting) · PIVOT (sharpen wedge/beachhead) · STOP.

---

**Critical path:** A → B (publish + Node portability) → C (prompt reliability ≥8/10) → E (sessions) → F.
The long pole is B; the single highest-risk gate is C's reliability bar.
