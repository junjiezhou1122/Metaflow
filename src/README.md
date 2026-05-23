# Source layout

This project is intentionally a single npm package for now. The source is split by runtime responsibility:

- `core/` — stable substrate types, schemas, SQLite store, env, LLM client.
- `connectors/` — adapters for external/local sources: Screenpipe, browser enrichment, local project/git, AI session locator.
- `runtime/` — background tick, workspace resolver, candidate thread correlation.
- `threads/` — WorkThread evidence maps, display interpreter, split/merge ops.
- `broker/` — ContextBroker / ContextPack assembly for plugins and agents.
- `plugins/` — plugin registry and built-in plugin compilers.
- `server/` — standalone HTTP server and iii worker entrypoints.

Keep raw observations in `core` types/store. Put source-specific acquisition in `connectors`, derived organization in `runtime`/`threads`/`broker`, and app-specific memory compilers in `plugins`.

## Runtime event log and timeline views

- `runtime_events` is an append-only provenance log for system behavior: ingestion, plugin runs, broker queries, view compilers, runtime ticks, and thread interpretation.
- `timeline.observations` is a derived `ContextView` over raw `ContextRecord` observations. It buckets recent records by time and preserves `source_records` links.

Useful commands:

```bash
pnpm run runtime:events -- --limit 50
pnpm run timeline -- --minutes 1440 --limit 100 --dry-run
pnpm run timeline -- --minutes 1440 --limit 100
```

Broker can also include provenance events when needed:

```bash
pnpm run context:query -- --events --no-records --no-views --event-types timeline_view_compiled,plugin_run_completed --limit 10
```

Daemon can maintain the timeline automatically:

```bash
pnpm run daemon -- --timeline --timeline-interval 300 --timeline-minutes 1440 --timeline-limit 200
```
