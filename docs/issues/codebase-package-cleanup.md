# Issue: Codebase Package Cleanup

## Problem

The repository is moving from one flat application tree toward package-level
boundaries. Some historical artifacts and old import paths still sit next to the
active runtime, making it hard to tell what is reusable package code, host
application code, compatibility surface, or local reference material.

## Current Findings

- Active reusable code now lives under `packages/`:
  - `packages/adapters/agent-runtime`
  - `packages/connectors`
  - `packages/views`
  - `apps/chrome-acp/packages/chrome-extension`
- Unreferenced `src/connectors/*.ts` and package-backed `src/runtime/*`
  compatibility re-exports have been archived under `archive/dead-code/`.
- Root `browser-extension/` has been superseded by `archive/browser-extension-legacy/`.
- `src/agents/` no longer contains implementation files.
- `craft-reference/` contains old static UI concepts and screenshots with no
  repository references. It belongs in `archive/craft-reference/`, not beside
  active runtime code.
- Empty package scaffolds under `packages/adapters/*` and
  `packages/evaluators/*` created false signals that implementations existed.
- Old package-level `visual-views.ts` re-export shims were redundant after the
  `visual-frame` and `activity-block` package indexes became the active entrypoints.
- The runtime UI is now under `packages/ui`, with root `ui:*` scripts delegating
  to its own Vite package.

## Cleanup Policy

- Move historical, unreferenced artifacts to `archive/`.
- Keep compatibility shims only when they preserve a current, tested import
  surface.
- Put new reusable implementation under `packages/`, not under `src/`.
- Keep `src/` focused on host orchestration: server, runtime, programs, broker,
  persistence, and compatibility entrypoints.
- Do not archive generated local outputs such as `packages/ui/dist/`; keep them
  ignored.

## Acceptance Criteria

- Active reusable package boundaries are documented in `packages/README.md`.
- `src/README.md` describes the current host/package split and no longer claims
  the project is intentionally a single npm package.
- Historical static UI prototypes are archived under `archive/`.
- Obsolete package View shims are archived under `archive/dead-code/`.
- Obsolete `src` package re-export shims are archived under `archive/dead-code/`.
- `packages/` contains no empty implementation placeholder directories.
- Active UI source lives under `packages/ui`, not root `ui/`.
- Typecheck and tests pass after the cleanup.

## Follow-Up Work

- Add an explicit package export map if this repo becomes a published workspace.
