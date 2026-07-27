# Personalized source smoke

`pnpm smoke:personalized-sources` is the opt-in local acceptance boundary for
selected Codex rollout records and selected Obsidian Markdown notes. It stages
only explicitly listed files under disposable, sanitized source names and then
runs the production Codex and Obsidian Connectors through `ConnectorRuntime`,
`CaptureIngress`, and a disposable SQLite View repository.

The smoke does not discover a user's home or vault automatically. Create a
configuration file outside the repository:

```json
{
  "version": 1,
  "codex_rollouts": ["/absolute/path/to/rollout-selected.jsonl"],
  "obsidian_vault_root": "/absolute/path/to/vault",
  "obsidian_notes": ["Projects/selected-note.md"],
  "obsidian_vault_id": "personalized-smoke"
}
```

Run it explicitly:

```sh
pnpm smoke:personalized-sources --config /absolute/path/to/smoke.json
```

Codex rollout paths and the Obsidian vault root are absolute; Obsidian note
selections are normalized paths relative to that root so their real vault-path
semantics survive Capture. Source paths are inputs only. Successful stdout is one strict, content-free
JSON object containing source counts, aggregate digests, at most 20 sampled
exact Raw View refs, an all-View manifest digest and truncation flag,
Schema summaries, checkpoint digests, exact batch replay proof, idle post-checkpoint
pull counts, trace counts, and cleanup
proof. It never contains note/message text, source paths or roots, credentials,
vectors, Representation values, or full checkpoint cursors. Unexpected errors
also use a content-free error envelope and a non-zero exit status.

The smoke fails instead of weakening the source contract when a source is not
a regular file, changes during staging, contains material rejected by the
Connector secret gate, has an incompatible rollout/Markdown format, produces no
Raw Views, changes its checkpoint during the replay pull, or cannot be cleaned
up. The Obsidian watcher is intentionally a no-I/O accelerator in this runner;
the Connector's complete logical-manifest scan remains the source of truth.

The committed deterministic test uses synthetic inputs only:

```sh
pnpm test:personalized-source-smoke
```
