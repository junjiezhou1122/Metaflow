# Metaflow v0 Archive

This directory preserves the pre-v1 implementation as migration evidence.
The code is intentionally outside the pnpm workspace, root dependencies,
default commands, TypeScript v1 project, and active test manifest.

```text
archive/v0/
├── packages/  former @info/core, views, processor/runtime, and sensor graph
├── apps/      former UI and application prototypes
├── scripts/   commands that depend on archived packages
└── tests/     non-default tests for archived behavior
```

Archive means retained, not supported. Files may be inspected and behavior may
be extracted, but active source must not import this tree. When a behavior is
migrated, implement it behind the canonical v1 module interface and add an
active test before changing this evidence.

The following legacy owners remain temporarily at their original paths because
their uncommitted or compatibility behavior still requires migration analysis:

- `packages/server`
- `packages/capabilities`
- `packages/programs`
- the isolated v0 calls inside `apps/chrome-acp` and `apps/mac`

Their owners and removal conditions are defined in
`wiki/architecture/v0-migration-inventory.md`.
