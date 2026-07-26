# @info Inline Invoke — Ambient Layer

## What is `@info`?

`@info` is an **inline intent resolution system** integrated into the Info personal context layer. It is **not a chatbot**. When a user types `@info <command>` anywhere in their workflow, the ambient layer parses the text, resolves it to a concrete intent, and dispatches to a registered handler.

## How It Works

1. **Detection** — Any text containing `@info` is captured by the ambient layer.
2. **Resolution** — `parseInlineIntent(text)` extracts one or more `InlineIntent` objects with confidence scores.
3. **Speed Mapping** — Each intent is mapped to a `SpeedTier` (`reflex`, `glance`, `think`, `work`, `background`).
4. **Handling** — The `AmbientLayer` dispatches the intent to its registered processor, which queries the `ContextStore` and returns an result.

## Supported Intents (MVP)

### `attach_local_file`
Attach and cite a local file from the context store.

```text
@info attach README.md
```
Speed tier: `glance`

### `check_or_cite_fact`
Check a claim against stored observations and return matching evidence.

```text
@info verify TypeScript is great
```
Speed tier: `think`

### `project_context`
Retrieve the current active thread and recent project observations.

```text
@info context
```
Speed tier: `glance`

## Speed Tier System

| Tier | Max Latency | Description |
|------|-------------|-------------|
| `reflex` | 50ms | Immediate, no IO |
| `glance` | 500ms | Quick local reads |
| `think` | 3s | Involved processing / LLM call |
| `work` | 15s | Heavier processing / agent task |
| `background` | 60s | Async, out-of-band |

## Architecture

```
user types: @info attach README.md
     |
     v
AmbientLayer.resolve(text)
     |
     v
parseInlineIntent(text) -> InlineIntent[]
     |
     v
AmbientLayer.handle(intent, text)
     |
     v
Registered processor (e.g. handleAttachLocalFile)
     |
     v
Query ContextStore -> produce AmbientIntentResult
```

## Extension Points

New intents and handlers can be registered by calling `AmbientLayer.register(processor)` before the layer handles text.

## Files

- `packages/ambient-layer/ambient-engine.ts` — Core engine, speed tiers, and built-in handlers
- `packages/ambient-layer/index.ts` — Package exports
- `tests/ambient-layer.test.ts` — Integration tests

