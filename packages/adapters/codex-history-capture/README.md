# Codex History Capture Connector

This package is a read-only Connector Kit adapter for complete newline-delimited
Codex rollout records. It reads only `sessions/**/rollout-*.jsonl` and
`archived_sessions/rollout-*.jsonl` beneath one exact Codex home. It never reads
Codex SQLite previews, `history.jsonl`, or `session_index.jsonl`.

## Safety boundary

The parser contract is exactly `codex-rollout-jsonl@0.145-safe-v3`. It follows
the official `SessionMeta` and `SessionMetaLine` source shape at
`openai/codex@95637f7056835fea66bdd0044414af480fc0fd74` while retaining explicit
compatibility with older 0.145 records. It admits
safe session metadata and user/assistant text only. Version 1 supports only
`content_mode: "messages"`; the former `metadata_only` shape is rejected as an
incompatible configuration because Capture has no canonical checkpoint-only
transition. Developer/system messages,
reasoning, tool calls and results, world state, instructions, duplicate event
projections, compaction data, images, and token/rate data are structurally
excluded. Optional Git, context-window, history, Agent, capability, dynamic-tool,
and base-instruction metadata is validated but never copied into candidates.
The outer RolloutLine timestamp and the nested SessionMeta timestamp are
independently validated because the official format does not require equality;
an optional outer ordinal is validated and excluded.
Unknown envelopes, event types, response types, content parts, and
changed session identity fail compatibility instead of being skipped.

Every accepted text field passes `secretlint`'s recommended v13 preset before a
`CaptureBatch` is created. A match rejects the record without redaction. The
error retains only session id, byte offset, record digest, rule ids, and policy
version; detector output, snippets, source bytes, and the absolute Codex home
are never copied into errors, traces, checkpoints, batches, or dead letters.

The cursor binds each file-map key to its inner session id, includes both in its
verified manifest digest, and verifies the SHA-256 of every committed byte
prefix. It advances only through complete newline-terminated records and is
keyed by session id rather than path. Moving an unchanged rollout from
`sessions` to `archived_sessions` therefore retains View identity. A tracked
session missing from every selected root, shorter file, changed committed
prefix, duplicate session id across files, or session-id change fails closed.
A complete suffix containing only excluded records raises
`codex_checkpoint_only_transition_unsupported` and does not advance; it never
creates a fake View to carry a checkpoint.

Every selected scope and rollout path must already be canonical and remain
beneath its resolved scope root. Symlink entries are rejected rather than
skipped. Before and after bounded reads, the adapter verifies the scope root,
resolved file path, named file, and open descriptor identities, then requires
device, inode, size, modification time, and change time to remain stable. An
ancestor replacement, final-component symlink, rewrite, or concurrent append
therefore fails before the affected batch is yielded, without including an
absolute source path in diagnostics.

## Composition

```ts
const connector = new CodexHistoryCaptureConnector({ codex_home });
const connection = codexHistorySourceConnection({
  source_root: "both",
  content_mode: "messages",
});
await configureCodexHistoryCapture({ runtime, connector, connection });
await runtime.run(connection.id, "pull", {});
```

The integration owner must add `@info/codex-history-capture-adapter` as a
composition-root workspace dependency and add
`tests/codex-history-capture.test.ts` to the active v1 test catalog. This branch
intentionally does not modify the root package manifest, lockfile, workspace
definition, or shared test catalog.
