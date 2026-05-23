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
