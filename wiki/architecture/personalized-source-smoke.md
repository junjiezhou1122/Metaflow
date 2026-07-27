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
  "obsidian_vault_id": "personalized-smoke",
  "workflow": {
    "enabled": true,
    "external_model_approved": true,
    "max_codex_messages": 8,
    "internal_query": "a phrase expected inside the selected note"
  }
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

When `workflow` is present, the runner uses the same resident ACP configuration
as the Ambient daemon and carries a bounded exact selection through Markdown
Parser Execution, approval-gated natural-language Transformation authoring,
Agent Execution, a working-state View, an Application Space, graph projection,
keyword/internal/relation Search, in-process/CLI/HTTP/MCP parity, Feedback
evolution, an independent `codex exec` using the installed Metaflow View-access
skill, the real Vite/React/Graphology/Sigma View Explorer, restart-safe exact
replay, and Privacy Forget. Both Agent and browser gates receive the same exact
working-state and Application Space refs and run before restart or Forget. The
Agent gate may call only bounded read Operations; the browser gate verifies a
nonblank Sigma canvas and synchronized accessible DOM without retaining a
screenshot. Their public evidence contains only counts, booleans, and digests.
The explicit
`external_model_approved` value is frozen into the Raw Views before Capture;
it is not a runtime override. Embedding remains disabled, so the content-free
result reports `not_run_no_authorized_embedding` instead of synthesizing a
semantic fallback.

The independent Codex process is also a real environment gate. The runner
fails with content-free authentication/MCP/network/configuration diagnostics
when `codex exec` cannot run; it never substitutes the resident ACP Agent or a
fixture. Refresh Codex authentication outside this command, verify it with a
minimal `codex exec`, and rerun the same smoke configuration.

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
