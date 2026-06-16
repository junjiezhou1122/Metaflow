# Memory Learning Quality

GitHub issue: https://github.com/junjiezhou1122/info/issues/4

## Problem

The memory framework now has `memory.candidate` and `processor.memory_gate`, but candidate quality is still rule-based. The next step is higher-quality learning from user feedback, edits, repeated instructions, work habits, and agent collaboration preferences.

## Scope

- Improve candidate generation for preferences, workflow patterns, skill gaps, project memory, and agent collaboration style.
- Add optional AI extraction behind privacy policy.
- Add conflict handling and evidence aggregation.

## Acceptance Criteria

- [ ] Repeated user instructions produce stronger candidate confidence than one-off signals.
- [ ] Edited outputs produce style/collaboration candidates without copying full sensitive text.
- [ ] Dismiss/insert/useful feedback changes future memory candidate ranking.
- [ ] Contradictory candidates are held or marked as conflict instead of blindly promoted.
- [ ] Memory gate merge behavior preserves evidence and last confirmation.
- [ ] The system can explain why a candidate was promoted, held, merged, or rejected.
- [ ] Secret/do_not_store sources are never included.

## Verification

- Add tests, suggested: `tests/memory-learning-quality.test.ts`.
- Add fixtures for repeated feedback, contradiction, and edited output.
- Required commands:
  - `pnpm typecheck`
  - `node --experimental-sqlite --import tsx --test tests/memory-learning-quality.test.ts tests/memory-candidate.test.ts tests/memory-gate.test.ts`
  - `pnpm mf memory candidates`

## PR Done When

- Candidate quality improvements are covered by tests and traceable through `mf memory trace`.
