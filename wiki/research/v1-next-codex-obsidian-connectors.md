# Metaflow v1-next: Codex History and Obsidian Connectors

Status: search-before-building recommendation, 2026-07-27. No connector code or
source data was changed during this research.

## Decision

Build two independent read-only Connector Kit adapters, not one generic
filesystem connector:

1. `codex-history-capture` reads only Codex rollout JSONL under the two known
   session roots. It incrementally emits one stable session metadata Raw View
   and independent message-occurrence Raw Views. It does not ingest reasoning,
   instructions, tool inputs/results, world state, shell snapshots, auth,
   configuration, images, or the SQLite previews.
2. `obsidian-capture` reads Markdown files from one exact vault root. It emits
   one stable document Raw View whose immutable revisions preserve exact UTF-8
   Markdown plus deterministic frontmatter and link descriptors. Attachments
   remain referenced by link descriptors in v1; the connector does not fetch or
   copy them.

Both are realistic with the current Capture Runtime. The implementation should
start with Obsidian, then Codex. Obsidian has a smaller, simpler acceptance
surface. Codex needs an explicit privacy gate because user/assistant message
text can itself contain credentials; excluding known sensitive record types is
necessary but cannot prove that arbitrary conversation text is secret-free.

Do not build either connector until the parser spike and secret-gate fixtures
in this report pass. In particular, do not silently redact a source record and
call it raw evidence.

## Claim map

```json
[
  {"id":"C1","claim":"The local Codex source is append-oriented JSONL plus index metadata, not a single conversation database","priority":"high","route":"local inspection"},
  {"id":"C2","claim":"The active Obsidian source is an iCloud-backed Markdown tree with frontmatter and wikilinks","priority":"high","route":"local inspection"},
  {"id":"C3","claim":"The current Connector Kit and Runtime can enforce strict payloads, deterministic Adapt, replay, policy inheritance, and atomic checkpoints","priority":"high","route":"repository inspection"},
  {"id":"C4","claim":"Durable file ingestion needs a committed logical manifest; watcher cursors are accelerators, not canonical truth","priority":"high","route":"official watcher and Node documentation"},
  {"id":"C5","claim":"Maintained parsers can cover CommonMark, YAML frontmatter, GFM, and most Obsidian wikilinks without regex parsing","priority":"medium","route":"package registry and upstream documentation"},
  {"id":"C6","claim":"Secret exclusion must happen before CaptureBatch creation because a failed attempted batch can enter the durable DLQ","priority":"high","route":"repository inspection and secret scanner documentation"}
]
```

## Verified local source reality

### Codex

Read-only inspection on 2026-07-27 found:

- `~/.codex/sessions` contains 3,886 rollout JSONL files and occupies about
  3.5 GB. `~/.codex/archived_sessions` contains 21 files and occupies about
  606 MB.
- `~/.codex/state_5.sqlite` has 3,906 thread rows: 3,885 point to the sessions
  tree and 21 to the archived tree. The `threads` table is an index with title,
  preview, cwd, model and rollout path; it is not the complete immutable trace.
- `~/.codex/history.jsonl` has 5,585 `{session_id,text,ts}` input-history rows.
  It is not a full conversation transcript. `session_index.jsonl` has only
  `{id,thread_name,updated_at}` rows.
- A current rollout begins with `session_meta` and then uses `turn_context`,
  `response_item`, `event_msg`, `world_state`, compaction and inter-agent
  records. Current `response_item.message` records use `user/input_text` and
  `assistant/output_text`; developer messages, image parts, reasoning,
  function/custom tool calls and tool outputs also occur.
- The sampled completed rollouts were valid newline-delimited JSON. A live file
  can still end in an incomplete line, so the reader must never checkpoint past
  the final complete newline.

The canonical connector source should therefore be rollout JSONL, with
`state_5.sqlite` used only during development/audit to cross-check discovery.
Runtime ingestion should not couple to Codex's private SQLite schema. It should
also ignore `history.jsonl`, which duplicates only user input, and
`session_index.jsonl`, which is a lossy title index.

### Obsidian

Obsidian's local config identifies the active vault as:

```text
vault id: <local-vault-id>
root: <user-configured-obsidian-vault-root>
```

The exact absolute root belongs only in the SourceConnection configuration and
must never be copied into Raw View aliases or search fields. The current vault
contains 661 Markdown files and 1,228 non-`.obsidian` files, occupying about
158 MB. It also contains 114 PNGs, 36 PDFs and other research artifacts. Of the
Markdown files, 332 contain frontmatter fences, 361 contain wikilinks and 207
contain Markdown links. Common frontmatter keys include `title`, `source_type`,
`url`, `source_id`, `date`, `status`, `type`, `source`, `aliases`, and `tags`.

The active vault is iCloud-backed and contains `.git` and `.obsidian` trees.
No symlinks were present at inspection time, but the adapter must still reject
or skip them by declared policy rather than follow them. Representative live
state surfaces include `Ambient/state.md`, `Projects/Ambient/README.md`,
`Projects/Ambient/Daily Window/state.md`, and `Notices/Daily/2026-07-26.md`.

## What the existing adapters already prove

The new connectors should compose the current boundaries, not create another
capture runtime.

| Existing surface | Pattern to reuse | Important limit |
| --- | --- | --- |
| `packages/capture/connector-kit.ts` | Strict configuration/payload schemas; explicit `stableSource` vs `occurrence`; declared emitted schemas; inherited non-weakening policy; deterministic candidate/batch creation | Adapt is pure. It does not own source I/O, persistence, or semantic lookup. |
| `packages/capture/connector-conformance.ts` | Reject malformed payloads, run Adapt twice, assert exact candidate count/schema/losslessness, and replay through the real Runtime | Every new connector needs this harness plus source-specific cursor tests. |
| `packages/adapters/clipboard-capture` | Smallest Kit example: preserve every accepted native field; use an occurrence for the event; keep files as external references; hash deterministic identities | Clipboard is push-only and has no discovery/watch cursor. |
| `packages/adapters/browser-capture` | Strict wire contract; explicit stable page/caption identities vs navigation/selection/copy occurrences; one source event can form an atomic multi-candidate batch | Browser still predates the Kit internally, so copy its identity reasoning, not its manual candidate construction. |
| `packages/adapters/screenpipe-capture` | Provider contract/version negotiation; per-modality cursors; bounded inclusive overlap; query fingerprint; replay-safe identities; secret references | Time watermarks fit Screenpipe, not files. Do not copy its offset semantics into filesystem ingestion. |
| `packages/capture/runtime.ts` | Batch ownership checks, durable checkpoint CAS, retries, DLQ, and trace | A batch containing secret text can be persisted in a DLQ after an attempted terminal failure. Secret rejection must occur before `createBatch`/`submitBatch`. |

Key repository evidence: Connector Kit separates payload parsing and Adapt at
`packages/capture/connector-kit.ts:114-153`, validates Adapt output and policy at
`:245-309`, and creates canonical batches at `:312-330`. Conformance replay is
checked at `packages/capture/connector-conformance.ts:80-130`. Capture Runtime
begins attempts and may create a dead letter at
`packages/capture/runtime.ts:106-150`.

## Reusable libraries and proven patterns

### File watching and incremental discovery

Use `@parcel/watcher` rather than a new `fs.watch` wrapper. Its upstream API
provides recursive `subscribe`, `writeSnapshot`, and `getEventsSince`; on macOS
it uses FSEvents, coalesces bursts, and represents a rename as delete plus
create. It is used by Parcel, VS Code, Nx and others. This repository already
depends on it in `apps/chrome-acp/packages/proxy-server` and uses it for
recursive events.

However, the watcher snapshot is only an accelerator. Node documents that
`fs.watch` behavior is platform-dependent and may be unreliable on some filesystems.
Watchman similarly recommends abstract clock cursors over timestamps because
timestamp queries have races. For Metaflow, the durable truth must be a logical
manifest committed in the Capture checkpoint:

```text
watch/snapshot event -> open exact file -> fstat -> read -> fstat again
  -> hash and parse -> create complete CaptureBatch
  -> Runtime atomically commits Views + logical manifest checkpoint
  -> write a new watcher snapshot as a disposable acceleration artifact
```

If the process crashes before the watcher snapshot is written, a full rescan
compares against the committed logical manifest and replays exact batches. That
is an observable recovery path, not a silent semantic fallback. Never write the
watcher snapshot before the Capture commit.

Use the maintained `ignore` package for gitignore-compatible path policy. Do
not translate `.gitignore` rules with custom glob/string logic. Connector-owned
deny rules are evaluated before any vault `.gitignore`; a source file cannot
re-include `.git`, `.obsidian`, a symlink, or another hard deny.

### Markdown, frontmatter, and links

Use a structured parser pipeline:

```text
unified@11 + remark-parse@11 + remark-frontmatter@5 + remark-gfm@4
  + yaml@2.8.x + a gated Obsidian wikilink extension
```

`remark-frontmatter` recognizes fences but deliberately does not parse their
contents, so parse its YAML node with `yaml.parseDocument` and reject any
document errors or warnings selected by policy. Pin `yaml@2.8.x` initially:
the current repo uses TypeScript 5.8.3, while the current `yaml@2.9` README says
its included typings require TypeScript 5.9.

The best current wikilink candidate found is
`@flowershow/remark-wiki-link@4.0.0` (MIT, updated 2026-06-23). Its documented
coverage includes `[[note]]`, aliases, heading links, and image/video/audio/PDF
embeds. Its README explicitly lists embedded notes and embedded note headings
as future support, and it does not establish complete Obsidian block-reference
coverage. Therefore adoption is gated by fixtures for `#heading`, `#^block`,
aliases, shortest-path ambiguity, and `![[note]]`. If any fixture fails, do not
patch around it with regex: isolate a small micromark extension behind an exact
`ObsidianLinkParser` port or run the parser inside an Obsidian plugin using the
official metadata cache. The latter is heavier but is the compatibility oracle.

Capture only extracts source link descriptors. It must not resolve `[[name]]`
to moving View heads or create guessed relations. Exact link resolution is a
later deterministic Transformation over frozen document revisions and a
frozen vault-path index.

### Secret scanning

Use `secretlint@13` with the recommended preset as a fail-closed pre-batch gate,
plus the connector's explicit structural exclusions. It is maintained, MIT,
pluggable, and supports rules that identify why text was flagged. It requires
Node 22+, which this machine satisfies (Node 24.14.0).

Secretlint is a detector, not a proof. The enforceable guarantee is:

- known secret-bearing sources/record types are never read into a payload;
- every accepted text field is scanned before `CaptureBatch` formation;
- a match rejects the complete file/record and does not redact it;
- the safe error contains only connection id, relative path or session id,
  byte offset, content digest, rule id and policy version;
- raw matched bytes, snippets and detector output never enter errors, traces,
  metadata, checkpoint, retry state, or DLQ;
- the checkpoint does not advance past the blocked item.

The current `RawViewCandidateSchema` rejects secret-like object keys and
credential-bearing URL forms, but deliberately does not scan arbitrary string
content (`packages/capture/contracts.ts:280-305`). The pre-batch content gate is
therefore required, not optional.

## Codex History exact contracts

### SourceConnection configuration

```ts
const CodexHistoryConfigurationSchema = z.object({
  source_root: z.enum(["sessions", "archived_sessions", "both"]),
  content_mode: z.enum(["metadata_only", "messages"]),
  max_record_bytes: z.number().int().min(1).max(8_000_000),
  max_files: z.number().int().min(1).max(20_000),
  secret_policy: z.literal("secretlint-recommend@13+codex-structural-v1"),
}).strict();
```

The adapter resolves the selected names beneath one exact `~/.codex` root. It
does not accept arbitrary absolute glob roots, URLs, credentials, or ignore
rules in v1. Use two connections if archived and active histories need
different retention policy.

Recommended SourceConnection policy for message mode:

```json
{
  "owner":"user:local",
  "visibility":"private",
  "privacy":"sensitive",
  "retention":"normal",
  "allow_external_model":false,
  "allow_embedding":false,
  "allow_local_search":true,
  "labels":["codex-history"]
}
```

### Source payload

The filesystem reader recognizes complete JSONL records, associates messages
with the most recent `turn_context.turn_id`, performs structural exclusion and
secret scanning, then hands this strict payload to Connector Kit:

```ts
const CodexSafeRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session_meta"),
    byte_offset: z.number().int().nonnegative(),
    byte_length: z.number().int().positive(),
    record_sha256: Sha256Schema,
    timestamp: TimestampSchema,
    session_id: IdentifierSchema,
    source: z.string().min(1).max(120),
    originator: z.string().min(1).max(120),
    cli_version: z.string().min(1).max(120),
    model_provider: z.string().min(1).max(120),
    workspace_path: z.string().min(1).max(4_096),
  }).strict(),
  z.object({
    kind: z.literal("message"),
    byte_offset: z.number().int().nonnegative(),
    byte_length: z.number().int().positive(),
    record_sha256: Sha256Schema,
    timestamp: TimestampSchema,
    session_id: IdentifierSchema,
    turn_id: IdentifierSchema.optional(),
    role: z.enum(["user", "assistant"]),
    text_parts: z.array(z.string().max(1_000_000)).min(1).max(32),
    omitted_non_text_parts: z.number().int().nonnegative(),
  }).strict(),
]);

const CodexHistorySourcePayloadSchema = z.object({
  version: z.literal(1),
  parser_contract: z.literal("codex-rollout-jsonl@0.145-safe-v1"),
  scope: z.enum(["sessions", "archived_sessions"]),
  relative_path: SafeRelativePathSchema,
  session_id: IdentifierSchema,
  from_offset: z.number().int().nonnegative(),
  through_offset: z.number().int().positive(),
  committed_prefix_sha256: Sha256Schema,
  observed_file_size: z.number().int().nonnegative(),
  observed_mtime_ms: z.number().int().nonnegative(),
  records: z.array(CodexSafeRecordSchema).min(1).max(256),
  excluded_record_counts: z.record(
    z.enum([
      "developer_or_system_message", "reasoning", "tool_call", "tool_result",
      "world_state", "event_duplicate", "instruction_or_context",
      "token_or_rate_metadata", "compaction", "image_or_attachment"
    ]),
    z.number().int().nonnegative()
  ),
}).strict();
```

`parser_contract` is intentionally exact. A new Codex record envelope, an
unknown message content type, a missing `session_meta`, invalid JSON before the
trailing partial line, duplicate session ids, or a changed committed prefix
throws `codex_source_contract_incompatible` or
`codex_append_history_rewritten`. It must not be counted and skipped silently.

The reader explicitly excludes:

- all developer/system messages and base instructions;
- `reasoning` and `encrypted_content`;
- function/custom tool call inputs and outputs;
- `world_state`, full turn context, environment, permissions and skills;
- token/rate metadata and duplicated `event_msg.user_message`/
  `event_msg.agent_message` projections;
- input images and attachments;
- every file outside `sessions/**/rollout-*.jsonl` and
  `archived_sessions/rollout-*.jsonl`.

### Deterministic Adapt

For `session_meta` emit `capture.codex.session@1` with:

```text
source identity = stable_source
source_id       = codex-session:<session_id>
idempotency     = sha256(connection_id, session_id, byte_offset)
representation  = the complete accepted session_meta record
```

For each message emit `capture.codex.message@1` with:

```text
source identity = occurrence
source_id       = codex-message:<session_id>:<byte_offset>
idempotency     = sha256(connection_id, session_id, byte_offset)
observed_at     = record timestamp
representation  = the complete accepted message record
```

The record digest remains in the Representation and batch replay fingerprint.
It is not part of the idempotency key: if bytes at a committed offset change,
the same key with different evidence must fail closed. Identical messages at
different offsets remain separate occurrences.

Search projection may include workspace path, role, timestamp and message text
only when `content_mode=messages` and `allow_local_search=true`. Never project
session ids or filesystem paths as general text. No summary, task extraction,
or workspace classification happens in Adapt.

### Cursor and replay

```ts
type CodexHistoryCursorV1 = {
  version: 1;
  discovery_manifest_sha256: string;
  files: Record<string, {
    scope: "sessions" | "archived_sessions";
    relative_path: string;
    session_id: string;
    committed_offset: number;
    committed_prefix_sha256: string;
    observed_size: number;
  }>;
};
```

The key is `session_id`, not path, so moving a rollout from active to archived
does not fork identity. Before reading an append, hash/verify the already
committed prefix. Read complete lines in batches of at most 256 records or the
configured byte limit. `through_offset` advances only after the complete batch
commits. An incomplete final line remains buffered only in memory and is
reread from the last committed byte on restart.

## Obsidian exact contracts

### SourceConnection configuration

```ts
const ObsidianConfigurationSchema = z.object({
  vault_id: IdentifierSchema,
  vault_root: z.string().min(1).max(4_096),
  include: z.array(z.literal("**/*.md")).length(1),
  max_file_bytes: z.number().int().min(1).max(8_000_000),
  identity_policy: z.literal("registry+resource-id+unique-digest-v1"),
  parser_contract: z.literal("obsidian-markdown-safe-v1"),
  secret_policy: z.literal("secretlint-recommend@13+frontmatter-v1"),
}).strict();
```

At connection registration, resolve the root once, require a directory, record
its device/resource identity in the safe adapter trace, and reject a later root
that resolves elsewhere. Hard denies are `.git/**`, `.obsidian/**`, hidden
directories, symlinks, non-Markdown files, temporary/conflict files and any
path escaping the real root. The reader never writes the vault or xattrs and
never asks iCloud to download an unavailable placeholder.

Recommended policy is private, `allow_external_model=false`,
`allow_embedding=false`, and `allow_local_search=true`. Use `privacy=sensitive`
for vaults that intentionally contain private credentials or journals.

### Source payload

```ts
const ObsidianFileRevisionSchema = z.object({
  sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
  mtime_ms: z.number().int().nonnegative(),
  file_resource_id: z.string().min(1).max(512).optional(),
}).strict();

const ObsidianSourcePayloadSchema = z.discriminatedUnion("operation", [
  z.object({
    version: z.literal(1),
    operation: z.literal("upsert"),
    vault_id: IdentifierSchema,
    document_id: IdentifierSchema,
    relative_path: SafeRelativePathSchema,
    observed_at: TimestampSchema,
    revision: ObsidianFileRevisionSchema,
    encoding: z.literal("utf-8"),
    markdown: z.string().max(8_000_000),
  }).strict(),
  z.object({
    version: z.literal(1),
    operation: z.literal("delete"),
    vault_id: IdentifierSchema,
    document_id: IdentifierSchema,
    relative_path: SafeRelativePathSchema,
    observed_at: TimestampSchema,
    prior_sha256: Sha256Schema,
  }).strict(),
]);
```

Open the file without following symlinks, then compare pre-read and post-read
`fstat` device, inode/resource id, size and mtime. If they differ, throw a
retryable `obsidian_file_changed_during_read` before forming a batch. Invalid
UTF-8, oversized content, malformed YAML, a secret match or an unavailable
iCloud file also fails before batch formation with a distinct safe code.

### Deterministic Adapt

For `upsert`, parse the exact `markdown` using the pinned parser pipeline and
emit one `capture.obsidian.document@1` stable-source candidate:

```ts
type ObsidianDocumentRepresentationV1 = {
  vault_id: string;
  document_id: string;
  relative_path: string;
  revision: { sha256: string; byte_length: number; mtime_ms: number };
  markdown: string; // exact accepted UTF-8 source
  frontmatter: null | { raw: string; value: JsonValue };
  headings: Array<{ depth: 1|2|3|4|5|6; text: string; slug: string }>;
  links: Array<{
    syntax: "markdown" | "wikilink" | "embed";
    target: string;
    alias?: string;
    heading?: string;
    block_id?: string;
    media_dimensions?: string;
  }>;
};
```

The source id is `obsidian-document:<vault_id>:<document_id>`. The idempotency
key is `sha256(connection_id, document_id, revision.sha256)`. The representation
retains the full Markdown, so parsed fields are an audited deterministic index,
not a replacement for source evidence. Parser name/version and policy version
belong in candidate metadata.

For `delete`, emit the same source id and Schema with
`kind=metaflow.source_tombstone` and value
`{source_deleted:true,reason:"source_deleted",changed_at:observed_at}`. A
document deletion is not inferred from one watcher callback; it is admitted
only after the committed logical manifest and a confirming rescan both show the
path absent.

Do not emit View relations from captured links. A wikilink target can be
ambiguous or missing, and a moving latest View is not an exact relation target.

### Stable document identity

The connector owns a durable identity registry inside its Capture checkpoint;
it never writes ids into source files:

```ts
type ObsidianIdentityEntryV1 = {
  document_id: string;
  current_relative_path: string;
  prior_paths: string[];
  file_resource_id?: string;
  last_sha256: string;
};
```

Identity decisions, in order:

1. Existing canonical relative path keeps its `document_id`.
2. A delete/create pair with the same trustworthy filesystem resource id keeps
   the id.
3. Within one coalesced rescan only, one deleted entry and one created entry
   with the same exact SHA-256 may be paired if the match is unique.
4. A new unmatched path gets `sha256(connection_id, vault_id,
   first_seen_relative_path)` as its registry id.
5. Multiple possible rename matches fail with `obsidian_identity_ambiguous`.

Resource ids and inodes are evidence, not portable canonical ids: iCloud can
rehydrate files and `@parcel/watcher` reports renames as delete/create. A rename
plus edit while the connector was offline may be impossible to prove. In that
case fail and request an explicit reconcile decision; do not silently merge or
fork the source identity.

### Cursor and replay

```ts
type ObsidianCursorV1 = {
  version: 1;
  vault_id: string;
  parser_contract: "obsidian-markdown-safe-v1";
  logical_manifest_sha256: string;
  documents: Record<string, ObsidianIdentityEntryV1 & {
    byte_length: number;
    mtime_ms: number;
  }>;
  watcher_snapshot: { path: string; sha256: string } | null;
};
```

Sort changed paths by normalized POSIX relative path before batch formation.
Normalize to Unicode NFC for comparison but retain the exact source spelling
in the Representation. A watcher snapshot miss/corruption emits an observable
recovery trace and triggers a manifest comparison. Replay after a crash uses
the same document id, content hash, candidate key and exact View revision.

## Realistic fixtures and acceptance tests

All fixture content should be synthetic or irreversibly sanitized. Do not copy
real conversation text or vault content into the repository.

### Shared gates

- Run `runConnectorConformance` with at least two valid cases, malformed
  payloads, exact schema/count assertions, lossless Representation checks and
  real Runtime replay.
- Submit the same payload twice and assert identical exact View refs and no
  duplicate outbox event.
- Reuse the same idempotency key with changed evidence and assert failure.
- Crash after View/checkpoint commit but before watcher snapshot, restart,
  rescan and prove exact replay.
- Verify candidate, error, trace, checkpoint and DLQ JSON contain no seeded
  canary secret or absolute vault/session root.
- Verify connection pause/disable fails before filesystem open or watcher work.

### Codex fixture set

1. `minimal-session.jsonl`: session meta, turn context, one user and one
   assistant message. Expect one session and two message candidates.
2. `excluded-records.jsonl`: developer instructions, reasoning,
   `encrypted_content`, tool input/output, world state, token count and duplicate
   event projections. Expect only safe records and exact exclusion counts.
3. `multiple-text-parts.jsonl`: multiple text parts plus an input image marker.
   Expect text preserved and the non-text count, never image data.
4. `partial-tail.part1`/`part2`: final JSON record split across reads. The first
   run must stop before it; the second admits it once.
5. `resume-append`: append after a committed prefix. Expect only new offsets.
6. `rewritten-prefix`: mutate one committed byte. Expect
   `codex_append_history_rewritten`, no batch and no cursor advance.
7. `active-to-archive`: move the same session file between roots. Expect the
   same source ids and exact replay.
8. `identical-messages`: identical text at different offsets. Expect two
   occurrence View ids.
9. `unknown-envelope`: a new outer or message content type. Expect contract
   incompatibility rather than skip.
10. `message-secret-canary`: a user message containing a deterministic fake
    credential pattern. Expect pre-batch rejection and no canary in persistence.

### Obsidian fixture vault

1. Plain Markdown with no frontmatter.
2. YAML with `title`, scalar/list `aliases`, tags, date, URL and nested values;
   verify exact raw YAML plus normalized JSON value.
3. Malformed YAML, duplicate keys, non-JSON YAML types/aliases and multiple
   frontmatter documents; each must have an explicit accept/reject fixture.
4. GFM table, task list, footnote, fenced code containing fake wikilinks, and
   inline code containing fake links. Code content must not become link nodes.
5. `[[note]]`, alias, `#heading`, `#^block`, shortest-path duplicate names,
   Markdown relative link, external URL, `![[image.png|200x300]]`, and
   `![[embedded note#heading]]`. These are the wikilink-library adoption gate.
6. Create/update/delete with exact document revision and source tombstone.
7. Rename with resource id; unique same-digest rename; ambiguous same-digest
   pair; offline rename-plus-edit. Assert the identity policy above.
8. File changed between read and post-read `fstat`; retry without admission.
9. Symlink inside vault pointing outside, `../` path, `.git`, `.obsidian`, hidden
   directory, conflict file and oversized Markdown. Assert no source read.
10. Unavailable iCloud placeholder and watcher snapshot corruption. Assert
    distinct observable recovery/failure and no silent drop.
11. Frontmatter URL with basic auth/query token and a Markdown secret canary.
    Assert pre-batch rejection and content-free diagnostics.

Also run the fixture vault through Obsidian's own metadata cache during the
parser spike. Compare extracted headings/link targets, but do not make the
Obsidian app/plugin a production dependency unless the standalone parser fails
the acceptance matrix.

## One personalized View scenario

Create an ordinary Transformation, not connector behavior:

```text
exact Codex message occurrences from the Metaflow repository work
  + exact Obsidian revisions of Ambient/state.md,
    Projects/Ambient/Daily Window/state.md,
    and that day's Notices/Daily note
  -> "Junjie's Metaflow working-state bridge"
```

The Derived View contains four sections: decisions already reflected in code,
decisions recorded only in the wiki, unresolved contradictions, and exact
source links. The Transformation freezes every message and document revision,
keeps Codex and Obsidian Raw Views separate even when semantically duplicate,
and records which claim came from which source. Feedback revises the
Transformation rather than either Raw View.

This is useful to Junjie's current workflow because it answers a concrete
question: "What did I decide in Codex today that has not yet become durable
wiki state, and what wiki commitment has not yet appeared in implementation?"
It also exercises the actual product model without turning Capture into a
summary/memory engine.

## Rejected shortcuts

- **One generic filesystem connector:** loses source-specific identity,
  privacy, parsing and compatibility failures.
- **Read Codex SQLite previews:** private schema, lossy content and duplicated
  truth. Rollout JSONL is the evidence source.
- **Ingest all Codex JSONL and filter later:** tool results, instructions,
  environment and reasoning would already be durable or enter DLQ.
- **Regex Markdown/frontmatter/wikilinks:** breaks on code fences, escapes,
  YAML typing, headings and Obsidian extensions.
- **Watcher event equals truth:** events are coalesced, rename is delete/create,
  and crash windows exist. The committed logical manifest is truth.
- **Content hash as the only document id:** every edit would fork identity, and
  two identical notes would collapse.
- **Path as the only document id:** every rename would fork identity.
- **Silent redaction:** destroys raw-source fidelity and conceals a privacy
  failure. Reject the complete source item before batch creation.
- **Resolve wikilinks in Adapt:** lookup-dependent and can create drifting or
  guessed relations. Resolve exact revisions in a later Transformation.

## Implementation order and go/no-go gates

1. Build the standalone Obsidian parser spike and compare its fixture output
   with Obsidian metadata cache. No production package yet.
2. Build the shared read-only file reader primitives: root containment,
   no-follow open, pre/post `fstat`, SHA-256, UTF-8 validation, secret gate and
   safe diagnostics. Keep this source-I/O utility below adapters; do not put it
   in Connector Kit.
3. Implement Obsidian Connector Kit, identity registry/cursor and conformance.
4. Prove full scan, watch, crash/replay, tombstone and iCloud-unavailable tests.
5. Implement the Codex JSONL parser with an exact compatibility fixture corpus.
6. Implement Codex Kit and byte-offset/prefix cursor, then run secret and
   archive-move tests.
7. Add the personalized Transformation only after both Raw connectors pass the
   same Runtime replay and policy tests.

No-go conditions: parser mismatch on required Obsidian syntax; any canary in
View/DLQ/trace/checkpoint; a cursor that advances before complete batch commit;
unbounded checkpoint growth without an explicit limit; ambiguous identity
silently resolved; or unknown Codex records silently skipped.

## Evidence and confidence

| Claim | Sources | Verdict | Notes |
| --- | --- | --- | --- |
| C1 | Local JSONL shapes, file counts/sizes, SQLite schema/counts | Strong | Current-machine evidence; Codex format is version-sensitive. |
| C2 | Obsidian config, vault tree/counts, structural pattern counts | Strong | Current-machine evidence; iCloud state and vault contents can change. |
| C3 | Connector Kit, conformance, Runtime, Browser/Screenpipe/Clipboard code/tests | Strong | Direct repository evidence. |
| C4 | `@parcel/watcher` upstream README, Node fs caveats, Watchman clockspec, local existing use | Strong | Snapshot API is proven; Metaflow logical-manifest composition is a recommendation. |
| C5 | unified/remark/YAML upstream docs and npm metadata; Flowershow README | Medium | Core Markdown/YAML stack is mature. Complete Obsidian syntax remains gated by fixtures. |
| C6 | Capture Runtime DLQ path, candidate secret checks, Secretlint docs | Strong for boundary; medium for detection | No scanner proves arbitrary text secret-free. |

No unresolved source contradiction changed the decision. The material weakness
is complete Obsidian-flavored Markdown compatibility: the most current reusable
plugin documents gaps, so the report requires an executable oracle comparison
before implementation.

## Sources

Local and repository:

1. `packages/capture/connector-kit.ts`
2. `packages/capture/connector-conformance.ts`
3. `packages/capture/runtime.ts`
4. `packages/capture/contracts.ts`
5. `packages/adapters/browser-capture/{wire.ts,adapter.ts}`
6. `packages/adapters/screenpipe-capture/{contracts.ts,adapter.ts}`
7. `packages/adapters/clipboard-capture/adapter.ts`
8. `tests/{connector-kit,browser-capture,screenpipe-capture}.test.ts`
9. Read-only structural inspection of `~/.codex` and the active Obsidian vault
   on 2026-07-27; no message/note content is reproduced here.

External:

10. `@parcel/watcher` README: <https://github.com/parcel-bundler/watcher>
11. Node.js `fs.watch` caveats: <https://nodejs.org/api/fs.html#caveats>
12. Watchman clockspec: <https://facebook.github.io/watchman/docs/clockspec>
13. unified: <https://github.com/unifiedjs/unified>
14. remark parse/frontmatter/GFM: <https://github.com/remarkjs>
15. YAML: <https://github.com/eemeli/yaml>
16. Flowershow Obsidian wikilinks: <https://github.com/flowershow/remark-wiki-link>
17. `ignore`: <https://github.com/kaelzhang/node-ignore>
18. Secretlint: <https://github.com/secretlint/secretlint>

## Research cost and method

- Planned 6 claims and verified each against local, repository, or upstream
  evidence.
- Used roughly 30 direct npm/upstream documentation lookups and no paid search
  API. Tool-metered research cost under the Deep Search table: `$0.000`.
- Deduplicated package registry metadata against upstream READMEs before making
  a recommendation.
- Official Obsidian Help is client-rendered and did not yield stable text in
  the shell fetch. Local vault syntax plus the plugin's explicit coverage/gaps
  are therefore the evidence used for the parser gate; an Obsidian metadata
  cache comparison remains required.
