# Facet — Publishing & Distribution Plan

> Status: **implemented — pending first publish.** The packaging in this plan has been applied:
> the published `@facet/*` packages are public at `0.1.0` with a proper `exports` map (a `bun`
> condition → source for the in-repo dev loop, `import` → built `./dist` for Node/Deno consumers),
> `tsdown` build configs, `main`/`types`/`files`/`sideEffects`/`engines`, `@facet/surface-kit`
> declared everywhere it is imported, the dead `@elysiajs/eden` dep removed, `elysia` demoted to an
> optional peer behind the `@facet/http/elysia` subpath, unused `zod` deps dropped, Changesets
> configured (`.changeset/`), and a Bun/Node/Deno CI matrix added (`.github/workflows/ci.yml`).
> What remains is the human's to run on a network-enabled machine: `bun install` the new devDeps
> (`tsdown`, `publint`, `@arethetypeswrong/cli`, `@changesets/cli` — confirm exact latest versions),
> `bun run build`, confirm `bun run publint` + `bun run attw` are green, then `bun run release`.
> The sections below are the original plan, kept as the rationale of record.

---

## 0. The current state and why it breaks

| Issue | Detail |
|---|---|
| `"private": true` on every `packages/*/package.json` | npm rejects the publish entirely |
| `"version": "0.0.0"` | not a valid semver release; registries accept it but consumers can't range-depend on it |
| `"exports": { ".": "./src/index.ts" }` | ships raw TypeScript; Node and Deno reject it; bundlers that don't handle `.ts` break silently |
| `workspace:*` in `"dependencies"` | a Bun/pnpm workspace protocol — npm strips it to `*` (matches anything) or breaks in non-workspace installs |
| No `"main"`, no `"types"`, no `"files"` field | resolution falls back to legacy heuristics; `publint` will flag every package |

---

## 1. Build tool — use `tsdown`

**Recommendation: `tsdown`.** Reasons specific to this library:

- `tsdown` is built on Rolldown (the Rust-native bundler) and designed explicitly as a
  TypeScript-library build tool — the spiritual successor to `tsup` with a cleaner config
  story and significantly faster cold builds.
- Bun is already used for the dev loop (`bun test`, `bun run`). `tsdown` runs under Bun
  natively (`bunx tsdown`) with no extra adapter. `tsup` works too but is esbuild-based
  and its `dts` generation still calls `tsc` under the hood — the same as `tsdown` but
  with more moving parts.
- `unbuild` is excellent for monorepos but adds its own config surface and the
  "stub" mode encourages skipping the build during dev in a way that hides real export
  problems until publish. Better to build for real and catch issues early.
- `tsdown` natively emits both `esm` and `cjs` output formats, `.d.ts` declarations via
  `vue-tsc`/`tsc`-compatible rollup, and a `package.json` `exports` map — all from one
  small config.

Add once to the root workspace, not per-package:

```bash
bun add -D tsdown -w
```

Per-package `tsdown.config.ts` (identical for every `packages/*` — extract to a shared
helper if desired):

```ts
// packages/core/tsdown.config.ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],          // ESM-only; CJS is unnecessary for a Bun-first lib (see §2)
  dts: true,                // emit .d.ts alongside .js
  sourcemap: true,
  clean: true,              // wipe dist/ before each build
  treeshake: true,
});
```

Root `package.json` build script:

```jsonc
// root package.json scripts
"scripts": {
  "build":       "bun run --filter '*' build",
  "build:watch": "bun run --filter '*' build:watch",
  "test":        "bun test",
  "typecheck":   "tsc -p tsconfig.base.json --noEmit",
  "lint":        "biome check .",
  "lint:fix":    "biome check --write .",
  "check":       "bun run scripts/check.ts"
}
```

Each package gets:

```jsonc
// packages/core/package.json (scripts fragment)
"scripts": {
  "build":       "tsdown",
  "build:watch": "tsdown --watch"
}
```

---

## 2. ESM-only vs dual CJS+ESM

Ship **ESM-only** (`"type": "module"`, single `dist/index.js` + `dist/index.d.ts`).

Rationale:
- Every target runtime (Bun, Node 22+, Deno) natively supports ESM. Dual-shipping CJS
  doubles the bundle, complicates the `exports` map, and creates the dual-package hazard
  (two copies of the same module in one graph → broken instanceof / prototype equality).
- Node 22 `require(esm)` (stable since Node 22.12 with `--experimental-require-module`
  removed as experimental in 22.12) means the tiny CJS-compat window has closed.
- The only consumers that genuinely need CJS today are legacy tooling (Jest without
  `--experimental-vm-modules`, Create React App, old Webpack configs). These are not
  Facet's target adopters. If a consumer files a bug, add a CJS entry then; don't pay
  the cost up front.

---

## 3. `package.json` `exports` map — per-package template

After the build, each package's `package.json` should look like this (using `@facet/core`
as the canonical example; adapt paths for each package):

```jsonc
{
  "name": "@facet/core",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "src"],
  "exports": {
    ".": {
      "import": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": {
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "typescript": ">=5.4"
  },
  "engines": {
    "node": ">=22"
  },
  "sideEffects": false
}
```

Notes:
- `"files"` includes `src/` alongside `dist/` so consumers who opt in to TypeScript
  source maps can navigate to the real source.
- `"main"` is a legacy fallback for tools that ignore `"exports"`. Keep it.
- `"types"` at the root level is the legacy fallback for TypeScript resolvers that
  predate `exports` condition support (`moduleResolution: node`). Keep it.
- No `"bun"`, `"deno"`, or `"browser"` condition is needed here — the engine is
  runtime-pure and the standard `"import"` condition resolves correctly on all three.
- `"sideEffects": false` enables tree-shaking in downstream bundlers.

### `@facet/http` — the one package with an optional Elysia wrapper

`@facet/http` exports both the framework-agnostic `createFetchHandler` and the optional
Elysia-specific `createHttpApp`. These live in the same entry today. Consider splitting:

```jsonc
"exports": {
  ".": {
    "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
  "./elysia": {
    "import": { "types": "./dist/app.d.ts", "default": "./dist/app.js" }
  }
}
```

This means a Hono or bare-`Bun.serve` user does not pull in the Elysia peer. Move
`elysia` and `@elysiajs/eden` from `"dependencies"` to `"peerDependencies"` (optional)
so they are not installed automatically:

```jsonc
"peerDependencies": {
  "elysia": ">=1.4",
  "typescript": ">=5.4"
},
"peerDependenciesMeta": {
  "elysia": { "optional": true }
}
```

### `@facet/parity` — dev/test only

`@facet/parity` is a testing harness, not a production dependency. It should be
published but marked clearly:

```jsonc
{
  "name": "@facet/parity",
  "publishConfig": { "access": "public" }
}
```

Consumers add it as a `devDependency`. The README should say so explicitly.

---

## 4. Versioning, `workspace:*`, and Changesets

### Why Changesets

`workspace:*` is a workspace-local protocol that npm does not understand. At publish
time it must be rewritten to real semver ranges (`^0.1.0`). Changesets automates this
replacement along with changelog generation and coordinated version bumps.

Alternative — **manual `bun publish --filter`**: Bun's `publish` command rewrites
`workspace:*` automatically since Bun 1.1. This works if you are comfortable with
manually managing changelogs and coordinated bumps. For a public framework where
consumers need predictable changelogs, Changesets is strongly preferred.

### Setup

```bash
bun add -D @changesets/cli -w
bunx changeset init
```

This creates `.changeset/config.json`. Configure it:

```jsonc
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

Key option: `"updateInternalDependencies": "patch"` — when `@facet/core` bumps,
`@facet/http`'s dep on it is automatically pinned to the new patch. This ensures
published packages always resolve to a coherent set.

### Release workflow

```
# 1. Author a changeset (one per logical change, during development)
bunx changeset add

# 2. Version all packages (runs the workspace:* rewrite)
bunx changeset version

# 3. Review the generated CHANGELOG.md files and version bumps, commit
git add . && git commit -m "chore: version packages"

# 4. Publish (build first, then publish each package)
bun run build
bunx changeset publish
```

`changeset publish` under Bun calls `npm publish` per package. If you prefer to use
`bun publish` directly, you can skip Changesets' publish step and instead do:

```bash
bun publish --filter '@facet/*' --access public
```

Bun 1.1+ rewrites `workspace:*` → the versioned range in the published tarball, so
either path works. The key requirement is that `version` has been bumped before publish.

---

## 5. Removing `private: true` and setting a real version

Each `packages/*/package.json` needs two changes before first publish:

1. Remove `"private": true` (or set it to `false`).
2. Set an initial version (`"0.1.0"` is conventional for a pre-1.0 public release).

Also add `"publishConfig"` to ensure npm access is public (the `@facet` scope defaults
to private on npm without this):

```jsonc
"publishConfig": {
  "access": "public"
}
```

Do these changes as part of the first Changesets `version` run, or manually for the
initial release. After that, Changesets owns version bumps.

The root `package.json` stays `"private": true` — it is the workspace root, not a
published package.

---

## 6. `publint` + `@arethetypeswrong/cli` in CI

These two tools catch the most common publish mistakes before they land in the registry.

```bash
bun add -D publint @arethetypeswrong/cli -w
```

Add to root `package.json`:

```jsonc
"scripts": {
  "publint": "bun run --filter '*' publint",
  "attw":    "bun run --filter '*' attw"
}
```

Per-package scripts (or run from root via filter):

```bash
# check exports map, files field, main/types fields
bunx publint packages/core

# check that TypeScript consumers on moduleResolution: node16/bundler/node get the right types
bunx attw --pack packages/core
```

`publint` catches: missing `"files"`, wrong `"main"` path, `"exports"` entries that
don't resolve, `.ts` files in `"exports"` (the current state).

`@arethetypeswrong/cli` catches: missing `"types"` condition, CJS/ESM type mismatch
(the "masquerading" problem), types that resolve differently under `node16` vs `bundler`
moduleResolution.

---

## 7. CI matrix — Bun + Node + Deno

The runtime-purity claim ("Bun-first but runs on Node 22+ and Deno") must be proven by
CI, not asserted. The engine is already runtime-pure (no `from "bun"` imports remain;
`discover.ts` uses `node:fs`). The CI step that proves it:

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  test-bun:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install
      - run: bun run build
      - run: bun test
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run publint
      - run: bun run attw

  test-node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: bun install        # use Bun for install in the workspace
      - run: bun run build      # build with Bun/tsdown
      - run: node --test packages/core/dist/__tests__/*.js
      # OR, if tests stay as Bun-style tests, run them through a Node-compatible runner:
      # - run: npx tsx --test packages/core/tests/...

  test-deno:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - uses: denoland/setup-deno@v2
        with: { deno-version: v2.x }
      - run: bun install
      - run: bun run build
      - run: deno run --allow-read --allow-env dist/... # import the built output
```

**Practical note on the Node/Deno test legs:** The existing test suite uses `bun:test`
APIs. For the Node/Deno legs you have two options:

1. **Keep tests Bun-only, run the _built output_ on Node/Deno** — a small smoke script
   that imports `@facet/core`, creates a registry, calls `execute()`, and asserts the
   result. This is the minimal proof that the built artifact loads and runs.
2. **Migrate tests to Vitest** — Vitest runs on all three runtimes and is API-compatible
   with `bun:test`. This is the thorough option and worth doing if Facet grows.

For now, option 1 unblocks the claim. A `tests/smoke-node.mjs` and
`tests/smoke-deno.ts` (committed to the repo) running against `dist/` is the fastest
path to a green Bun/Node/Deno matrix.

---

## 8. Recommended release flow (full sequence)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │  One-time setup (first release only)                    │
                    │                                                         │
                    │  1. bun add -D tsdown @changesets/cli publint           │
                    │        @arethetypeswrong/cli -w                        │
                    │  2. bunx changeset init  (configure config.json)        │
                    │  3. Add tsdown.config.ts to each packages/*/           │
                    │  4. Update each packages/*/package.json:                │
                    │       - remove "private": true                          │
                    │       - set "version": "0.1.0"                         │
                    │       - replace exports map (see §3)                    │
                    │       - add "files", "main", "types", "sideEffects"     │
                    │       - add "publishConfig": { "access": "public" }     │
                    │       - move workspace:* deps to real ranges            │
                    │         (Changesets handles this after first version)   │
                    │  5. npm login --scope=@facet                            │
                    │  6. bun run build && bunx changeset publish             │
                    └─────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────────────────────┐
                    │  Ongoing (every change)                                 │
                    │                                                         │
                    │  1. Develop feature on a branch                        │
                    │  2. bunx changeset add  (major/minor/patch + summary)   │
                    │  3. PR → CI runs: build, test×3 runtimes, publint,      │
                    │     attw, typecheck, lint                               │
                    │  4. Merge to main                                       │
                    │  5. (Optional) Changesets GitHub Action opens a         │
                    │     "Version Packages" PR automatically                 │
                    │  6. Merge the version PR → CI publishes to npm          │
                    └─────────────────────────────────────────────────────────┘
```

### Changesets GitHub Action (optional but recommended)

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build
      - uses: changesets/action@v1
        with:
          publish: bunx changeset publish
          version: bunx changeset version
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

This opens a "Version Packages" PR on every merge to main. When that PR is merged, it
publishes automatically.

---

## 9. What to do about `@facet/surface-kit`

`@facet/surface-kit` currently has one dependency (`@facet/core`) and a single source
file. Before publishing, clarify whether it is:

- A public utility for host authors (publish it); or
- An internal implementation detail (`private: true` is correct, import it only
  within the monorepo).

If it stays internal, remove it from the publish pipeline. If it goes public, apply
the same `package.json` treatment as the other packages.

---

## Summary

- **Build:** `tsdown` (Rolldown-based, Bun-native, single config per package) emits
  `dist/index.js` + `dist/index.d.ts` in ESM-only format. ESM-only is correct for a
  Bun-first library targeting Node 22+ and Deno — no dual-package hazard.

- **Exports map:** each package gets a proper `"exports"` map with `"import"` →
  `"types"` + `"default"`, a legacy `"main"` fallback, root-level `"types"`, `"files"`
  including `dist/` and `src/`, `"sideEffects": false`, and `"publishConfig":
  { "access": "public" }`. `@facet/http` splits its Elysia wrapper to an `./elysia`
  subpath with optional peer deps.

- **`workspace:*` and versioning:** Changesets owns version coordination and rewrites
  `workspace:*` to real semver ranges in published tarballs. Config sets
  `"updateInternalDependencies": "patch"` so internal dep ranges stay coherent across
  releases.

- **Publish gate:** `publint` (exports-map correctness) and `@arethetypeswrong/cli`
  (TypeScript resolution under all `moduleResolution` modes) run in CI on every PR and
  must be green before merge.

- **Runtime-purity CI matrix:** three parallel jobs — Bun (full `bun test`), Node 22
  (smoke-tests the built `dist/` output), Deno (same smoke script via `npm:` imports) —
  prove the "Bun-first but not Bun-only" claim mechanically rather than by assertion.
