# Project System Views

GitHub issue: https://github.com/junjiezhou1122/info/issues/6

## Problem

`project.current` and `project.memory` exist, but the project system is incomplete. The system still needs generated project inbox, tasks, decisions, and stronger project continuity from Codex/Claude/browser observations.

## Scope

- Implement real processors for `project.inbox`, `project.tasks`, and `project.decisions`.
- Improve project continuity from AI session logs, local project observations, and browser research.
- Keep project as a View family, not a closed core object.

## Acceptance Criteria

- [ ] `project.inbox` captures unresolved project-relevant items.
- [ ] `project.tasks` extracts actionable tasks with source provenance.
- [ ] `project.decisions` extracts decisions with rationale and uncertainty.
- [ ] Codex/Claude session observations contribute to project views.
- [ ] Unrelated browser pages/messages do not enter project views unless routed through `work.focus_set`.
- [ ] Multi-project scenarios create separate project views.
- [ ] Views are traceable with `pnpm mf view trace`.

## Verification

- Add tests, suggested: `tests/project-system-views.test.ts`.
- Include multi-project, interruption, decision, and task fixtures.
- Required commands:
  - `pnpm typecheck`
  - `node --experimental-sqlite --import tsx --test tests/project-system-views.test.ts tests/project-current-view.test.ts`
  - `pnpm mf view latest project.current`

## PR Done When

- Project continuity can be inspected from CLI and has deterministic tests.
