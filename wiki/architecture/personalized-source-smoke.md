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

Connector Marketplace/onboarding product UX is not part of this acceptance
gate. Sources remain explicitly configured, and new Connectors continue to use
the existing code-first Connector Kit. A natural-language authoring UI is also
deferred: users or Agents may edit View Package, Transformation, Operator, and
Automation definitions in code. The existing approval-gated authoring contracts
remain available as backend capability, but neither product surface blocks this
workflow.

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
evolution, an independent Claude Code ACP process using a staged project-level
Metaflow View-access skill, the real Vite/React/Graphology/Sigma View Explorer,
restart-safe exact replay, and Privacy Forget. Both Agent and browser gates receive the same exact
working-state and Application Space refs and run before restart or Forget. The
Agent gate admits only the two approved literal Search requests, the two exact
View reads, and one exact-root bounded graph projection before the underlying
Operation service can observe a call. Timeout and output-limit termination
close the independent ACP process and escalate from `SIGTERM` to `SIGKILL`
inside the shared runtime's fixed bounds. The browser gate
validates the exact graph root, exact `view.get` request and response, a
nonblank Sigma canvas, and synchronized accessible DOM; it then resolves,
mounts, and disposes the trusted JSON Renderer through the Web Renderer Host
against that same working-state revision. No screenshot or rendered content is
retained. Their public evidence contains only counts, booleans, and digests.
The Agent receives exact Search request templates but never the expected View
refs. Those refs stay inside the host validator, forcing Search discovery before
the exact reads. Any assistant preamble mixed with the final JSON remains a
structured-output failure instead of being heuristically stripped.
The content-free Agent evidence contract is v2 and identifies `claude_acp` over
MCP. The explicit `external_model_approved` value is frozen into the Raw Views before Capture;
it is not a runtime override. Embedding remains disabled, so the content-free
result reports `not_run_no_authorized_embedding` instead of synthesizing a
semantic fallback.

The independent Claude ACP process is also a real environment gate. It is a
fresh process and session, separate from the ACP process that formed the
working-state View. The runner fails with content-free
authentication/MCP/network/configuration diagnostics
when Claude ACP cannot run; it never substitutes Codex, the primary workflow
session, or a fixture. Refresh Claude authentication outside this command,
verify the configured Claude Code ACP entrypoint with a minimal prompt, and
rerun the same smoke configuration.

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
