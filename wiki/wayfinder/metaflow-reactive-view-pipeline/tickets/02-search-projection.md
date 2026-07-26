## Question

How should lossless source-native Representations declare deterministic searchable text and metadata without mutating Raw Views or forcing OCR, transcription, summarization, or embedding at capture time?

## Acceptance criteria

- Define a versioned search projection contract for Schema-declared fields, source-provided text, identifiers, URLs, timestamps, and provenance.
- Replace whole-JSON `LIKE` scanning with real SQLite FTS and deterministic relevance/order behavior.
- Keep external media referenced; enrichment that changes semantic information creates a Derived View through a Transformation.
- Make indexing and reindexing idempotent, observable, policy-aware, and recoverable after schema evolution or crash.
- Distinguish deterministic capture-time projection from later AI-created semantic Views and optional future embeddings.

## Verification method

- Test exact field inclusion/exclusion, ranking, tokenizer behavior, policy exclusions, replay, reindex, and rollback.
- Demonstrate search over Browser, Screenpipe, and the Connector Kit example without source-specific query code.
