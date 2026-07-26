# Web View Renderers

`@info/web-view-renderers` is the fail-fast Web host for declarative View
Package Renderer descriptors. It resolves one descriptor deterministically,
loads only the exact `id@version@abi_version` implementation, mounts one exact
View revision, and records load, mount, capability, abort, and dispose events.

The package does not discover View Packages, read a View Store, import SQLite,
fetch URLs, commit Views, or choose an undeclared generic fallback. An app owns
those composition concerns.

## Wiring

The future Web composition root must do all of the following explicitly:

1. Read Renderer descriptors and Method ids from one exact installed View
   Package version.
2. Construct a `WebRendererRegistry` with trusted registrations. Import
   `createBuiltInWebRendererRegistrations` from `@info/web-view-renderers/builtins`
   only when the app wants the built-ins to be installable.
3. Project one authorized exact View into `WebRendererInputSchema`. Inline
   Representations contain only kind, optional media type, and JSON value;
   external Representations replace every URI, path, digest, and metadata field
   with one opaque `asset_id` bound to an authorized materialization. Do not pass
   policy, provenance, storage locations, credentials, or external URLs.
   The View owner remains responsible for Schema validation before projection;
   this adapter validates the narrow browser contract and does not recreate
   View Core validation.
4. Supply `RendererHostServices` backed by the app's authenticated Operation,
   asset, link, telemetry, and background-error observer ports. The background
   observer is required because an aborted non-cooperative factory can resolve
   only after the caller has already received its abort error.
5. Call `registry.mount(...)`, retain the returned handle, and await
   `dispose()` or `disposed` during navigation and abort.

Installing a built-in implementation does not select it. A View Package must
still declare the matching descriptor for its exact Schema, Representation
kind, surface, optional media type, priority, and ABI. Zero matches, missing
registrations, and ABI mismatches throw distinct errors.

## Host capabilities

Renderer code receives only:

- `resolveAsset`, limited to an `asset_id` already present in the frozen input;
- `invokeMethod`, limited to a Method id declared by the exact View Package;
- `openLink`, limited to absolute HTTPS or mailto requests delegated to the
  host.

Resolved media must be a host-created `blob:` URL with exact type and bounded
bytes. Both known- and unknown-length assets are capped by the materialization
authorization and the exported 64 MiB `MAX_WEB_RENDERER_ASSET_BYTES` host
ceiling; renderer requests cannot raise either bound. The host releases resolved
assets during disposal, including a disposable returned after mount abort.
Lifecycle events contain renderer identity, exact View ref, stage, duration, and
bounded error codes; they never contain Representation content, asset URLs, or
link URLs.
Lifecycle observer failures are propagated only after required renderer and
asset cleanup has run.

## Built-ins

- `renderer.web.json@1@1` renders only explicit inline JSON.
- `renderer.web.markdown@1@1` uses `react-markdown@10.1.0` with GFM,
  `skipHtml`, a reviewed element list, no images, and host-routed safe links.
- `renderer.web.image@1@1` renders a host-resolved image blob with explicit
  loading and failure states.
- `renderer.web.table@1@1` derives columns only from a strict JSON Schema and
  uses TanStack Table for local sorting. It fails above 1,000 rows; a later
  explicit virtualized renderer must own larger tables.

The Markdown and table implementations are MIT dependencies. React and
ReactDOM are MIT host peers, which prevents the adapter from installing a
second React runtime. No Gephi Lite or other GPL source is included.

## Focused verification

```bash
node --import tsx --test packages/adapters/web-view-renderers/web-view-renderers.test.ts tests/view-package.test.ts
corepack pnpm typecheck:v1
corepack pnpm check:boundaries
```
