# Metaflow

Metaflow is a local-first information runtime for personal AI. It captures
source evidence as immutable Raw Views, transforms exact View revisions through
versioned Operators, and keeps results, feedback, failures, policy decisions,
and traces inspectable.

```text
external source
  -> Connector Runtime
  -> immutable Raw View revisions
  -> versioned Transformation + Operator
  -> observable Run
  -> Derived View / Failure View
  -> Feedback and explicit evolution
```

An Observation is the product name for a Raw View. It is not a second storage
model. Every View has a Schema, Representation, Materialization, provenance,
policy, and an immutable revision.

## Current Capabilities

- Browser and Screenpipe evidence enter through one provider-neutral Capture
  Runtime with idempotency, checkpoints, retry, traces, and dead letters.
- Function and Agent Operators execute frozen Transformation revisions through
  one observable Execution Runtime.
- Exact input bindings, access approval, output validation, atomic commits,
  cancellation, Failure Views, and explicit repair are shared runtime behavior.
- Feedback is an ordinary View and can evolve a Transformation through durable
  compare-and-swap revisions.
- CLI, HTTP, MCP, and in-process callers project the same v1 Operation catalog.
- Ambient Browser, macOS push-to-talk, and scheduled summary flows reuse the
  same Capture, Execution, Delivery, Feedback, and trace owners.
- Privacy Forget computes exact provenance impact, coordinates cleanup, and
  permanently retires forgotten View identities.

The visual graph explorer, Application Spaces, marketplace, and general
external side effects are later product layers. The archived v0 React UI is not
the v1 interface.

## Repository Layout

```text
packages/
  view/                 recursive View contract and repository ports
  transformation/       Transformation and Operator contracts
  execution/            Runs, authorization, validation, commit, failure, repair
  automation/           Trigger-to-context-to-target-to-delivery lifecycle
  capture/              Connector Runtime and Capture Ingress
  operations/           shared public operation catalog
  adapters/             independent SQLite, source, runtime, and surface adapters

apps/
  ambient-daemon/       canonical v1 composition root and HTTP server
  chrome-acp/           Browser source and delivery integration in migration
  mac/                  native push-to-talk and Delivery integration
  website/              product website

scripts/v1/             canonical CLI, MCP, and active-test entrypoints
wiki/                   canonical v1 architecture and decision history
archive/                retired artifacts and compatibility fixtures
```

The old `packages/core`, `packages/server`, Processor, Program, View-system,
runtime, and React UI sources remain in the repository only as migration
evidence. They are not workspace packages, root dependencies, default commands,
or default tests.

## Quick Start

Requirements:

- Node.js 22+ with `node:sqlite`
- Corepack/pnpm
- an explicit ACP-compatible Agent command for Agent Operators

Install the canonical 22-project v1 workspace:

```bash
corepack pnpm install
```

Start the Ambient v1 HTTP daemon:

```bash
METAFLOW_AUTH_TOKEN='<local-random-secret-at-least-32-bearer-characters>' \
  METAFLOW_TRUSTED_OPERATION_ORIGINS='chrome-extension://<extension-id>' \
  AGENT_TASK_ACP_COMMAND='<your-acp-command>' \
  corepack pnpm dev
```

The daemon defaults to the IPv4 loopback origin `http://127.0.0.1:3111` and
fails at startup if the Agent command, Operations Bearer token, or a required
composition port is absent. Doctor is credential-free; Operations, compatibility
exact reads, and HTTP MCP require `Authorization: Bearer <token>` and reject
browser origins unless the exact origin is explicitly trusted. Configure the
same token as the Chrome extension's `operationAuthToken` setting and in the
macOS app environment. Both UI clients first verify the credential-free,
nonce-bound doctor response at the configured loopback origin and send the
Bearer token only after the exact server and Operation catalog contract passes;
remote or credential-bearing endpoint configuration fails closed. The Chrome
extension restricts local storage to trusted extension contexts before it
migrates, reads, or writes the token; unsupported isolation clears the legacy
token and refuses credential use, while content scripts receive only projected
non-secret settings from the background. Never place the token in Agent prompts
or skills. Set
`METAFLOW_DATA_DIR` to change the SQLite data directory.

Health and exact View reads:

```text
GET  /health
GET  /context/v1/views/<view-id>?revision=<positive-integer>
```

Canonical Operations use:

```text
POST /metaflow/v1/operations/<operation-name>
```

Browser Capture and Ambient transports use:

```text
POST /capture/v1/browser-events
POST /automation/v1/browser-signals
GET  /automation/v1/browser-deliveries
POST /automation/v1/browser-interactions

POST /automation/v1/macos/voice-signals
GET  /automation/v1/macos/deliveries
POST /automation/v1/macos/interactions

GET  /automation/v1/inbox/deliveries
POST /automation/v1/inbox/interactions
```

## CLI And MCP

The CLI accepts one canonical operation plus a JSON input:

```bash
AGENT_TASK_ACP_COMMAND='<your-acp-command>' \
  corepack pnpm mf catalog.list '{}'

AGENT_TASK_ACP_COMMAND='<your-acp-command>' \
  corepack pnpm mf view.get '{"ref":{"view_id":"view:example","revision":1}}'
```

Start the official MCP SDK projection over stdio:

```bash
AGENT_TASK_ACP_COMMAND='<your-acp-command>' corepack pnpm mcp
```

CLI, HTTP, MCP, and in-process calls use the same schemas, authorization,
structured envelope, and observer path. A transport does not reconstruct domain
behavior.

## Source Integrations

Build the Chrome source surface:

```bash
corepack pnpm browser:build
```

The Browser Capture transport posts canonical events to
`/capture/v1/browser-events` and retains network failures in extension storage
until an explicit retry. Retryable 408/425/429/5xx responses remain there too,
because they are not server acceptance. Some older side-panel functions remain a documented
temporary compatibility surface and are not part of the canonical workspace.
The MV3 worker persists visit identity in session storage, uses alarms and
web-navigation events, and shares one validated wire schema with the HTTP and
adapter surfaces. Manual save commits page evidence and save intent atomically.

Screenpipe is separately installed and accessed through its localhost REST API.
Metaflow does not vendor Screenpipe or read its internal SQLite. Large frame and
audio media remain external references unless a policy explicitly requires
materialization.

Build or run the signed macOS companion bundle:

```bash
corepack pnpm mac:bundle
corepack pnpm mac:run
```

The raw SwiftPM executable is not valid permission evidence because it does not
carry the bundle's privacy usage descriptions.

## Verification

```bash
corepack pnpm typecheck
corepack pnpm check:boundaries
corepack pnpm test
corepack pnpm test:v1-vertical
```

`pnpm test` reads an explicit active-test manifest. Archived v0 tests are not
silently mixed into the v1 release gate.

## Canonical Docs

- [View Core and Transformation Runtime](wiki/architecture/view-core-transformation-runtime.md)
- [Ambient Automation Runtime](wiki/architecture/ambient-automation-runtime.md)
- [v0 Migration Inventory](wiki/architecture/v0-migration-inventory.md)
- [View Core Wayfinder Map](wiki/wayfinder/metaflow-view-core/map.md)

The `wiki/` directory is the v1 documentation source of truth. `docs/` and the
archived source tree describe historical designs only.
