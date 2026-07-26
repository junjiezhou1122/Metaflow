## Question

What exact event, ports, package ownership, and transactional boundaries make a committed View the only valid starting point for reactive downstream work?

## Acceptance criteria

- Define one exact-revision `ViewCommitted` event for Raw and Derived Views, including transaction/batch identity, commit origin, policy-safe metadata, and replay identity.
- Fix ownership across `view`, `capture`, `automation`, `execution`, storage adapters, and the future III adapter without adding a Worker domain layer.
- State which facts are persisted atomically with a View, which are published after commit, and how publication is recovered after a process crash.
- Record that rolled-back, forgotten, session-only, or `do_not_store` Views cannot leak into durable triggers.
- Add dependency and contract tests that reject archived v0 owners and cyclic package imports.

## Verification method

- Review the canonical architecture document and `AGENTS.md` together.
- Run focused contract tests, `pnpm typecheck:v1`, and `pnpm check:boundaries`.
