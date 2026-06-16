# Proactive Action Layer

GitHub issue: https://github.com/junjiezhou1122/info/issues/5

## Problem

The system can understand and remember context, but it does not yet consistently perform useful background work. We need a proactive action layer that turns eligible Views into low-risk background tasks, drafts, research, or suggested actions.

## Scope

- Define action/task Views and autonomy policy.
- Support silent work, side-panel inbox work, and confirmation-required work.
- Record outcomes as observations/views for learning.

## Acceptance Criteria

- [ ] The system can create background tasks from eligible Views.
- [ ] Each task declares autonomy level, risk, sources, and required confirmation policy.
- [ ] Low-risk tasks can run silently; higher-risk tasks require user confirmation.
- [ ] Outcomes are written as structured Views/observations.
- [ ] Failed actions produce learnable outcome records.
- [ ] No file/browser/network action bypasses policy.
- [ ] Tasks can be inspected from CLI or UI.

## Verification

- Add tests, suggested: `tests/proactive-action-layer.test.ts`.
- Include fixtures for silent draft, confirm-required action, and failure outcome.
- Required commands:
  - `pnpm typecheck`
  - `node --experimental-sqlite --import tsx --test tests/proactive-action-layer.test.ts tests/program-runtime.test.ts`
  - `pnpm mf processor report`

## PR Done When

- A reviewer can see when an action ran, why it ran, what sources it used, and whether policy allowed it.
