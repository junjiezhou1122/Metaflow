# Issue: Codebase Package Cleanup

## Problem

The repository is moving from one flat application tree toward package-level
boundaries. Some historical artifacts and old import paths still sit next to the
active runtime, making it hard to tell what is reusable package code, host
application code, compatibility surface, or local reference material.

## Current Findings

- Active reusable code now lives under `packages/`:
  - `packages/capabilities/agent-runtime`
  - `packages/sensors`
  - `packages/views`
  - `apps/chrome-acp/packages/chrome-extension`
- Unreferenced `src/connectors/*.ts` and package-backed `src/runtime/*`
  compatibility re-exports have been archived under `archive/dead-code/`.
- Root `browser-extension/` has been superseded by `archive/browser-extension-legacy/`.
- There is no active root `src/` tree; host code now lives in workspace packages
  such as `packages/server`, `packages/runtime`, and `packages/programs`.
- `craft-reference/` contains old static UI concepts and screenshots with no
  repository references. It has been archived under `archive/craft-reference/`.
- Empty package scaffolds under old `packages/adapters/*` and
  `packages/evaluators/*` created false signals that implementations existed;
  active agent runtime code is under `packages/capabilities/agent-runtime`.
- Old package-level `visual-views.ts` re-export shims were redundant after the
  `visual-frame` and `activity-block` package indexes became the active entrypoints.
- The runtime UI is now under `apps/ui`, with root `ui:*` scripts delegating to
  its own Vite package.

## Cleanup Policy

- Move historical, unreferenced artifacts to `archive/`.
- Keep compatibility shims only when they preserve a current, tested import
  surface.
- Put new reusable implementation under `packages/`, not under a revived root
  `src/`.
- Keep host orchestration in the matching package: HTTP in `packages/server`,
  ticks/background work in `packages/runtime`, Programs in `packages/programs`,
  and persistence/policy in `packages/core`.
- Do not archive generated local outputs such as `apps/ui/dist/`; keep them
  ignored or handle them through the app's build policy.

## Acceptance Criteria

- Active reusable package boundaries are documented in `packages/README.md`.
- Root/package docs describe that there is no active root `src/` tree.
- Historical static UI prototypes are archived under `archive/`.
- Obsolete package View shims are archived under `archive/dead-code/`.
- Obsolete `src` package re-export shims are archived under `archive/dead-code/`.
- `packages/` contains no empty implementation placeholder directories.
- Active UI source lives under `apps/ui`, not root `ui/`.
- Typecheck and tests pass after the cleanup.

## Follow-Up Work

- Add an explicit package export map if this repo becomes a published workspace.
