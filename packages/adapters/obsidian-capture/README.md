# Obsidian Capture adapter

This package is the read-only Connector Kit adapter for one exact Obsidian
vault root. It emits stable `capture.obsidian.document@1` Raw Views and source
tombstones through the shared Capture Runtime. It does not resolve links,
fetch attachments, infer relations, mutate the vault, redact source evidence,
or own retry, checkpoint, trace, or DLQ persistence.

## Contract

`ObsidianConfigurationSchema` requires an absolute `vault_root`, one exact
`vault_id`, `**/*.md`, the pinned parser/identity/secret policies, and an 8 MB
maximum file bound. The absolute root remains only in Source Connection
configuration. Candidates, checkpoints, safe errors, traces, and watcher
diagnostics use relative paths and content/resource digests only.

Each accepted file is opened read-only with `O_NOFOLLOW` after root containment
and component symlink checks. Discovery freezes the vault root and file
device/inode identity; the opened handle must match before any bytes are read,
and the post-read path must still name that handle. The adapter also compares
size and mtime around the exact read, validates fatal UTF-8, parses the full
Markdown source, and runs Secretlint plus structural frontmatter checks before
forming a Capture Batch. A rejected file blocks the scan and cannot enter
Runtime retry or DLQ state.

The parser uses unified, remark-parse, remark-frontmatter, remark-gfm, YAML,
and a small attributed micromark Obsidian-link bridge. It preserves exact UTF-8
Markdown and extracts deterministic frontmatter, headings, Markdown links,
wikilinks, block/heading fragments, embeds, and media dimensions. Link targets
remain unresolved source descriptors and candidate relations are always empty.

## Identity and checkpoints

The bounded logical manifest is the durable truth. Existing paths retain their
document id; a unique resource id or unique exact digest can prove a rename;
ambiguous or unprovable delete/create sets fail. Batches are sorted by NFC
relative path, and every batch advances only its own manifest transition so a
mid-scan crash cannot checkpoint uncommitted documents. Deletion requires a
second full discovery pass before a tombstone is formed. The cursor also
retains bounded root identity and retired relative-path evidence, so restart
rejects a replaced vault root and a deleted source cannot accidentally append
to its terminal tombstone identity. Tombstoning retires the current path and
every historical path under collision checks. Rename history is never silently
truncated: the 101st distinct prior path fails before checkpoint advancement.
Resource-id and unique-digest evidence is reconciled before same-path
convenience, so a document cannot silently take another identity's path.
Same-path same-content inode replacement emits an immutable revision with a
distinct replay identity and advances the registry's exact resource evidence.

Parcel watcher snapshots live under the system temporary directory, outside
the vault. They only prioritize full discovery and are written after the last
Capture commit. Missing or corrupt snapshots produce a structured recovery
diagnostic and a full logical-manifest scan. A post-commit snapshot failure is
reported distinctly; the already committed checkpoint remains authoritative.

## Composition

The integration owner should add `@info/obsidian-capture-adapter` to the root
composition dependency set, register `ObsidianCaptureAdapter`, create a Source
Connection with `obsidianSourceConnection`, and add
`tests/obsidian-capture.test.ts` to the explicit active test catalog. This
issue intentionally does not modify the shared root manifest or test catalog.
