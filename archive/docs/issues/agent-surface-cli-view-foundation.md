# Build Agent Surface CLI and dynamic View foundation

GitHub parent issue: https://github.com/junjiezhou1122/Metaflow/issues/17

Parent tracking issue for the CLI-first work discussed in the view redesign. UI remains a consumer of the same underlying HTTP/CLI/ViewSpec contracts, not the source of truth.

## What to build

Build the bottom-layer Agent Surface CLI and dynamic View foundation for Metaflow. Agents should be able to inspect canonical Views, discover processors, trigger allowed processors, read Screenpipe-backed evidence, and create/edit dynamic Views without depending on the UI.

## Acceptance criteria

- [x] Agent-facing CLI commands are JSON-first and have stable stdout, stderr, and exit semantics.
- [x] Canonical Views are readable through the CLI: `state.surface`, `work.focus_set`, `project.current`, `memory.daily`, and `memory.profile`.
- [x] Processors can be inspected and whitelisted processors can be triggered with Processor Run evidence.
- [x] Dynamic Views can be created or edited by humans and agents with provenance/audit metadata.
- [x] Screenpipe evidence can be queried through Metaflow CLI entrypoints and optionally normalized into Observations.
- [x] Daily/profile memory are markdown-backed editable Views.
- [x] CLI docs and smoke tests cover the agent-facing flows.

## Blocked by

None - can start immediately

## Slices

1. **Agent Surface CLI JSON Contract**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/18
   - Type: AFK
   - Blocked by: None
   - User stories covered: agent can call CLI reliably; machine-readable errors and exit codes.

2. **View Read CLI for Canonical Views**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/19
   - Type: AFK
   - Blocked by: Agent Surface CLI JSON Contract
   - User stories covered: agent can inspect `state.surface`, `work.focus_set`, `project.current`, `memory.daily`, `memory.profile`.

3. **Processor Inspect and Trigger CLI**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/20
   - Type: AFK
   - Blocked by: Agent Surface CLI JSON Contract
   - User stories covered: agent can discover processors and trigger allowed processors with run evidence.

4. **Dynamic View Create/Edit CLI**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/21
   - Type: AFK
   - Blocked by: Agent Surface CLI JSON Contract, View Read CLI for Canonical Views
   - User stories covered: human and agent can add/edit views dynamically with provenance.

5. **Screenpipe Evidence Access Through Metaflow CLI**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/25
   - Type: AFK
   - Blocked by: Agent Surface CLI JSON Contract
   - User stories covered: agent can query Screenpipe-like evidence through Metaflow.

6. **Memory Daily/Profile Markdown Views**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/22
   - Type: AFK
   - Blocked by: View Read CLI for Canonical Views, Dynamic View Create/Edit CLI
   - User stories covered: daily markdown memory and durable profile memory are editable and reusable.

7. **Agent-Facing CLI Docs and Smoke Tests**
   - GitHub issue: https://github.com/junjiezhou1122/Metaflow/issues/23
   - Type: AFK
   - Blocked by: Agent Surface CLI JSON Contract, View Read CLI for Canonical Views, Processor Inspect and Trigger CLI, Dynamic View Create/Edit CLI, Screenpipe Evidence Access Through Metaflow CLI, Memory Daily/Profile Markdown Views
   - User stories covered: other agents can follow the CLI contract without UI.

Note: https://github.com/junjiezhou1122/Metaflow/issues/24 appears to be a duplicate docs issue created by a retry after intermittent GitHub API EOF errors. It should be closed or repurposed when GitHub API access is stable.

## Implementation Status

- Implemented: JSON envelope for `mf --json`.
- Implemented: canonical `mf state` read path for `state.surface`, `work.focus_set`, `project.current`, `memory.daily`, and `memory.profile`.
- Implemented: `mf view upsert <json_file|-> [--actor agent|user]` for dynamic View creation/edit with provenance.
- Implemented: `mf processor run <processor_id> --record <record_id>` and `mf processor run <processor_id> --view <view_id>` for whitelisted processor triggers with Processor Run evidence.
- Implemented: Processor runtime v0 can execute local, CLI, and HTTP processor workers; LLM/AgentTask processor runtimes support handler-backed execution and fail with explicit bridge configuration errors otherwise.
- Implemented: `mf sensor screenpipe status/search` with Screenpipe filter passthrough and optional `--write` normalization into Observations.
- Implemented: `mf memory daily show|write|sync` and `mf memory profile show|write|sync` for markdown-backed editable memory Views.
- Implemented: UI view surfaces prioritize canonical Agent Surface families and use source/provenance summaries instead of treating `confidence` as the primary signal for canonical Views.
- Implemented: agent-facing CLI contract docs at `docs/agent-surface-cli.md`.
- Verified: `pnpm typecheck`.
- Verified: `pnpm test -- tests/processor-runtime.test.ts`.
- Verified: `pnpm test -- tests/mf-cli.test.ts tests/mf-memory-cli.test.ts tests/view-system.test.ts`.
- Verified: `node --experimental-sqlite --import tsx --test tests/ui-agent-surface.test.ts tests/processor-runtime.test.ts tests/mf-cli.test.ts tests/mf-memory-cli.test.ts tests/view-system.test.ts`.
- Verified: `pnpm --dir apps/ui run build`.
