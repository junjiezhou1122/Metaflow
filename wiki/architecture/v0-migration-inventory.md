---
name: v0-migration-inventory
title: v0 Migration Inventory
desc: Canonical classification of every former active v0 owner, surface, route, command, and temporary compatibility adapter.
created: 2026-07-26T00:00:00+08:00
updated: 2026-07-27T00:00:00+08:00
---

# v0 Migration Inventory

[[_index|..]]

This inventory closes the boundary between the verified Metaflow v1 front half
and retained v0 evidence. `archive` means source may remain in the repository,
but it is not a workspace package, root dependency, default command, active
test, or canonical owner. It must not be imported by active v1 source.

The following YAML block is the machine-readable inventory.

```yaml
version: 1
canonical_workspace:
  - packages/view
  - packages/view-package
  - packages/transformation
  - packages/execution
  - packages/automation
  - packages/capture
  - packages/operations
  - packages/adapters/*
  - view-packages/*
  - apps/ambient-daemon
  - apps/website

capability_paths:
  - path: archive/v0/packages/core
    original_path: packages/core
    disposition: archive
    replacement: packages/view + packages/operations
  - path: archive/v0/packages/views
    original_path: packages/views
    disposition: archive
    replacement: packages/view + versioned Transformations
  - path: archive/v0/packages/view-system
    original_path: packages/view-system
    disposition: archive
    replacement: packages/view + packages/transformation
  - path: archive/v0/packages/processor-runtime
    original_path: packages/processor-runtime
    disposition: archive
    replacement: packages/transformation + packages/execution
  - path: archive/v0/packages/runtime
    original_path: packages/runtime
    disposition: archive
    replacement: packages/execution + packages/automation
  - path: packages/programs
    disposition: archive
    replacement: versioned Transformations and Automation Views
  - path: packages/capabilities
    disposition: archive
    replacement: packages/adapters/agent-runtime + packages/execution
  - path: archive/v0/packages/sensors
    original_path: packages/sensors
    disposition: archive
    replacement: packages/capture + source adapters
  - path: archive/v0/packages/ambient-layer
    original_path: packages/ambient-layer
    disposition: archive
    replacement: packages/automation
  - path: archive/v0/packages/iii-runtime
    original_path: packages/iii-runtime
    disposition: archive
    replacement: explicit adapters; III remains an optional future adapter
  - path: archive/v0/packages/scheduled-batch
    original_path: packages/scheduled-batch
    disposition: archive
    replacement: packages/adapters/scheduler-automation
  - path: packages/server
    disposition: archive
    replacement: apps/ambient-daemon/http-handler.ts + packages/operations

application_paths:
  - path: apps/ambient-daemon
    disposition: migrate
    state: complete
    replacement: canonical v1 composition root
  - path: archive/v0/apps/ui
    original_path: apps/ui
    disposition: archive
    replacement: future v1 graph explorer; out of current map scope
  - path: archive/v0/apps/english-learning
    original_path: apps/english-learning
    disposition: archive
    replacement: future Application Space; out of current map scope
  - path: apps/chrome-acp
    disposition: adapt_temporarily
    replacement: canonical Browser Capture and Automation modules plus isolated legacy UI
  - path: apps/mac
    disposition: adapt_temporarily
    replacement: canonical voice/Delivery routes plus isolated passive v0 calls
  - path: apps/website
    disposition: migrate
    state: retained_non_runtime_surface

archived_support_paths:
  - path: archive/v0/scripts
    original_path: scripts/*.ts
    disposition: archive
    scope: commands importing archived v0 package owners
  - path: archive/v0/tests
    original_path: tests/*.test.ts
    disposition: archive
    scope: tests excluded from the explicit active v1 manifest

route_paths:
  - path: packages/server/http-server.ts:/capture/v1,/automation/v1,/context/v1/views
    disposition: migrate
    state: complete
    replacement: apps/ambient-daemon/http-handler.ts
  - path: packages/server/http-server.ts:/metaflow/v1/operations/*
    disposition: migrate
    state: complete
    replacement: packages/adapters/operation-surfaces + apps/ambient-daemon/http-handler.ts
  - path: packages/server/http-server.ts:all-v0-context-program-processor-agenttask-timeline-routes
    disposition: archive
    replacement: none; future behavior must enter through a versioned v1 capability
  - path: packages/server/http-server.ts:/context/v1/observations
    disposition: archive
    replacement: /capture/v1/browser-events or capture.ingest

command_paths:
  - path: root:dev,http,ambient:daemon
    disposition: migrate
    state: complete
    replacement: apps/ambient-daemon/index.ts
  - path: root:mf
    disposition: migrate
    state: complete
    replacement: scripts/v1/operations-cli.ts
  - path: root:mcp
    disposition: migrate
    state: complete
    replacement: scripts/v1/operations-mcp.ts
  - path: root:test,typecheck,check:boundaries
    disposition: migrate
    state: complete
    replacement: explicit v1 suite and boundary checks
  - path: root:iii:worker,daemon,runtime:*,context:*,program,timeline,pipeline:tick,background-tasks,toolsmith-artifacts
    disposition: archive
    replacement: none
  - path: root:test:ingest,test:pack,test:pack:v2,correlate:recent,ai-session:locate,thread,episode:summary,local-project:once,screenshot:once,mobile-screenshot:inbox,agent-discovery:example,screenpipe:recent,tweet-save:example,plugin:language
    disposition: archive
    replacement: none
  - path: root:ui:dev,ui:build,ui:preview
    disposition: archive
    replacement: future v1 graph explorer

compatibility_adapters:
  - id: chrome-sidepanel-v0-functions
    path: apps/chrome-acp/packages/chrome-extension/src/lib/info-capture.ts
    owner: apps/chrome-acp Browser surface
    callers: legacy side-panel chat, writing, learning, and feedback UI
    telemetry: infoCaptureDeadLetters + infoAutomationDeadLetters + structured console failures
    removal_condition: each caller moves to an exact v1 Operation or is removed with its archived UI
  - id: mac-passive-v0-calls
    path: apps/mac/Sources/MetaflowMac/MetaflowMac.swift
    owner: apps/mac
    callers: passive focus/writing and old feedback UI only
    telemetry: native request failure logs; v1 voice path has Automation and Execution traces
    removal_condition: passive capture receives a declared v1 Connector contract and feedback uses exact Feedback Views
  - id: chrome-proxy-info-tools
    path: apps/chrome-acp/packages/proxy-server/src/mcp/info-handler.ts
    owner: apps/chrome-acp proxy server
    callers: opt-in legacy info_search_context/info_get_view/info_submit_feedback tools
    telemetry: pino request/error logs with endpoint and tool name
    removal_condition: tools are replaced by canonical metaflow_* MCP Operations or deleted

deleted_paths:
  - path: packages/adapters/browser-capture/legacy.ts
    disposition: delete
    replacement: canonical BrowserCaptureEvent wire contract; retained side-panel ContextRecords post only to /context/ingest
  - path: packages/server/http-server.ts:/context/v1/observations
    disposition: delete
    replacement: /capture/v1/browser-events for canonical capture and /context/ingest for isolated v0 side-panel records
  - path: tests/view-v1.test.ts:legacy-/context/v1/observations-HTTP-cases
    disposition: delete
    replacement: Browser Capture and Ambient v1 HTTP contract tests
  - path: tests/browser-automation-http.test.ts:legacy-server-composition
    disposition: delete
    replacement: apps/ambient-daemon/http-handler.ts contract tests
```

## Enforced Boundary

`tests/v0-migration-boundaries.test.ts` verifies the canonical workspace list,
root dependencies and commands, active source imports, and explicit active-test
manifest. `dependency-cruiser.config.cjs` separately enforces inward dependency
direction for every v1 capability and adapter package.

The compatibility adapters above are not alternative domain owners. They may
translate or transport an old caller shape, but only Capture Ingress,
OperationService, Automation, and Execution may admit, authorize, execute, or
commit v1 state. Unknown or unsupported requests fail explicitly.
