# Info — Adaptive Memory Runtime

## Optimization goal

Maximize passing test count. Each improvement adds new tests that verify a
previously-unimplemented feature from the design docs, then implements the
feature until the new tests pass.

## Metric

`EVO_SCORE` = number of passing tests (max). Baseline = 671.

## Resource profile

- Binding resource: CPU-light, in-memory, fully isolated (SQLite per-test tmpdir)
- One benchmark run: ~60-120s wall-clock for 671 tests on 8-core Mac
- Safe round width: 4 subagents concurrently without contention
- Backend: worktree (local)

## Target areas (priority order)

### 1. Hybrid Work Router builtins
`processor.work_router_batch` and `processor.project_current` declared in
ViewSpecs as producers but have no registered builtin processor implementations.
Files: `packages/processor-runtime/builtins/`

### 2. Evolution apply CLI (`mf evolution`)
Entire apply/verify/rollback layer absent. Docs in `docs/evolution-engine.md`
specify: `candidates`, `show`, `apply`, `verify`, `rollback` commands.
Files: `scripts/mf.ts`, new handler module

### 3. Feedback → Memory pipeline
`processor.memory_profile_update` not registered as builtin.
Files: `packages/processor-runtime/builtins/`

### 4. View merge / split / diff / promote
Store and CLI only have fork/update/delete.
Files: `packages/core/store.ts`, `scripts/mf.ts`

## Gates

- All existing 671 tests must continue to pass
- `pnpm typecheck` must exit 0
- No test stubs with todo/skip markers
