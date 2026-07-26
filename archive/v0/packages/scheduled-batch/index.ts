// @info/scheduled-batch — Scheduled/on-demand AI batch processor for work/project synthesis.
//
// Responsibilities:
// 1. Build a bounded context window from recent records and views.
// 2. Classify work vs interruptions (distractions).
// 3. Only invoke external LLM when privacy settings allow.
// 4. Produce structured Views: decisions, open questions, next actions, candidate memories.
// 5. No-op deterministic fallback when LLM is unavailable or disallowed.
// 6. Never blocks realtime observation ingest.

export * from './types.js';
export * from './batch-processor.js';
export * from './context-window.js';
export * from './classifier.js';
export * from './view-producers.js';
