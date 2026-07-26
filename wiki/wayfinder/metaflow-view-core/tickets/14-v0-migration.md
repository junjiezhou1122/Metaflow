## Question

How should v0 and the experimental v1 prototype be retired after the verified vertical slice without preserving two competing owners for View, Capture, Runtime, or Surface behavior?

## Depends on

- Verify the Browser/Screenpipe-to-evolving-View vertical slice

## Acceptance criteria

- Every active v0 path is classified as migrate, adapt temporarily, archive, or delete.
- Compatibility adapters have named owners, callers, telemetry, and removal conditions.
- Active packages and apps use only the confirmed capability direction.
- No active import depends on archived prototypes.
- Canonical wiki and `AGENTS.md` describe the post-migration tree and commands.
- Mainline remains buildable and tests pass at each migration checkpoint.

## Verification method

- Audit active imports, workspace packages, routes, commands, and archive boundaries.
- Run package typechecks, focused contract tests, full tests, and the end-to-end slice after each removal batch.
