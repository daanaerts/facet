# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It owns version
bumps, changelogs, and the `workspace:*` → real-range rewrite at publish time for every published
`@facet/*` package.

`@facet/parity` is `private` and listed under `ignore` — it is a dev/test harness and is never published.

## Workflow

```bash
bun run changeset          # author a changeset (major/minor/patch + summary) per logical change
bun run version:packages   # apply pending changesets → bump versions + write CHANGELOGs
bun run release            # build all packages, then `changeset publish` to npm
```

The packages are at `0.1.0` (the manual initial public version). The first changeset you add after
this drives the next bump. See [`docs/PUBLISHING.md`](../docs/PUBLISHING.md) for the full story.
