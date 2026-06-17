# Scheduled AI Batch Layer

GitHub issue: https://github.com/junjiezhou1122/info/issues/3

## Problem

`work.focus_set` and `project.current` are currently mostly deterministic. The system needs a scheduled or idle-time AI batch layer that can summarize recent work, classify main work versus interruptions, and propose memory/project updates without blocking realtime paths.

## Scope

- Add a scheduled/on-demand batch processor path.
- Input: recent `state.surface`, `work.focus_set`, `project.current`, relevant observations, and memory candidates.
- Output: AI-assisted summaries and update proposals as Views, not direct mutations.
- Keep realtime processors deterministic and API-key-free.

## Acceptance Criteria

- [ ] A batch processor can run on demand and from a schedule/idle trigger.
- [ ] It reads a bounded context window and records the exact source records/views used.
- [ ] It distinguishes main work lanes from interruptions.
- [ ] It produces structured Views for decisions, open questions, next actions, and candidate memories.
- [ ] It respects privacy: no external LLM when any source disallows it.
- [ ] It has deterministic fallback behavior when no LLM is configured.
- [ ] It does not block realtime observation ingest.

## Verification

- Add targeted tests, suggested: `tests/scheduled-ai-batch.test.ts`.
- Add runtime integration coverage for dry-run and write mode.
- Required commands:
  - `pnpm typecheck`
  - `node --experimental-sqlite --import tsx --test tests/scheduled-ai-batch.test.ts tests/runtime-tick.test.ts`
  - `pnpm mf processor report`

## PR Done When

- All acceptance criteria are demonstrated in tests or transcript evidence.
- Docs explain how realtime and scheduled paths differ.
