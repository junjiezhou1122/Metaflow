# Metaflow View Explorer

`@info/view-explorer` is the canonical v1 graph work surface. It is an app
composition root, not a graph domain owner: production reads use only the
same-origin `view.graph.project`, `view.get`, and `view.search` Operation HTTP
surfaces. Graphology is disposable browser state, Sigma is the sole visual
engine, and worker positions/camera state never become View relations.

## Wiring

- Root scripts: `pnpm view-explorer:dev`, `pnpm view-explorer:build`,
  `pnpm view-explorer:test`, and `pnpm view-explorer:test:e2e`.
- Production endpoint: `POST /metaflow/v1/operations/<operation>` on the same
  origin. The app enforces a fixed 2 MiB response ceiling while streaming.
- Browser decoding imports only `@info/view/schema`, `@info/view/graph`, and
  `@info/search/contracts`; server services and Node crypto stay out of the
  browser bundle.
- Fixture-only entry: `?fixture=1|10|500|2000|personalized`; it injects an
  in-memory Operation transport and performs no Operation network requests.
  The deterministic `personalized` fixture contains synthetic Codex and
  Obsidian Raw Views, one working-state bridge, and one Application Space. Its
  `view:fixture:view-explorer:personalized:*` refs are sanitized UI-only
  identities and never claim to be the backend acceptance Views or personal
  data. The personalized Playwright scenario drives this same fixture through
  the production-shaped HTTP Operation boundary.
- Exact entry: `?root=<encoded-view-id>@<revision>`. Query state stores exact
  refs, filters, selection, and camera only; no View content is placed in URLs.
- The ambient daemon must serve the built static app or proxy its Vite server
  and same-origin Operation path at integration time. This branch does not
  change daemon static-file composition.

## Verification

```bash
pnpm view-explorer:test
pnpm view-explorer:build
pnpm view-explorer:test:e2e
```

The production build enforces [bundle-baseline.json](./bundle-baseline.json).
Graphology `0.26.0`, Sigma `3.0.3`, ForceAtlas2 `0.10.1`, and noverlap `0.4.2`
are MIT licensed; React is MIT, Lucide is ISC, Vite is MIT, and Playwright is
Apache-2.0. Cytoscape, React Flow, OpenSeadragon, and vis-timeline are excluded.
PNGJS is MIT licensed and is used only by Playwright to decode screenshot pixels.
