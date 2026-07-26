# Active Packages

`packages/` contains only the active Metaflow v1 domain modules and adapters.
Historical v0 implementations live under `archive/v0/`; they are migration
evidence and may not be imported by active source.

## Dependency direction

```text
apps
  -> adapters
    -> operations / automation / capture / execution
      -> transformation
        -> view

view-packages/* -> view-package -> transformation + view
```

The active modules are:

- `view/`: exact View revisions, Schema, Representation, Materialization,
  policy, provenance, relations, search projection, and the View Store port.
- `view-package/`: coherent Schema-family authoring, Renderer and Agent Method
  descriptors, catalog discovery, version checks, and conformance tests.
- `transformation/`: immutable Transformation and Operator declarations.
- `execution/`: authorization, exact input resolution, Operator execution,
  validation, atomic commit, traces, feedback evolution, Failure Views, and
  explicit repair.
- `automation/`: deterministic Trigger admission, exact target invocation,
  Delivery requests, and correlated Automation traces.
- `capture/`: Connector Kit, Connector Runtime, Raw View candidate admission,
  checkpoints, traces, and dead letters.
- `operations/`: the transport-neutral operation catalog and call-level
  authorization.
- `adapters/*`: replaceable implementations for storage, capture sources,
  Operator hosts, Automation triggers, Delivery surfaces, and transports.

## Rules

- Import another module through its package name, never through a relative
  cross-package path.
- Domain modules do not import adapters or apps.
- Adapters implement an existing interface at a real seam; they do not own
  View, Transformation, Run, policy, or commit semantics.
- CLI, HTTP, MCP, Web, and Agent tools project `@info/operations`; they do not
  reconstruct domain behavior.
- A new v1 capability must be added to `pnpm-workspace.yaml`,
  `tsconfig.v1.json`, the package-boundary checks, and focused interface tests.
- Do not move archived v0 code back into `packages/`. Extract the needed
  behavior into its named v1 owner with a migration test.
