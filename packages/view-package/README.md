# View Package

`@info/view-package` is the authoring and discovery module for coherent View
capabilities. A package declares Schema versions, accepted Representations,
Materialization profiles, exact Processor and Parser descriptors, human Renderer
descriptors, Agent Methods, and explicit Schema evolutions in one fail-fast
manifest.

The module owns manifest validation, exact reference checks, catalog conflict
detection, discovery, and conformance. Fixtures include envelope relations, so
strict Schema relation projections are checked across Representation and
managed relation evidence. It does not execute Renderers, read or write SQLite,
invoke Operators, expose transports, or migrate stored Views.
Those implementations remain behind the existing View Store, Transformation,
Execution, Operations, app, and adapter interfaces.

```text
defineViewPackage(manifest)
  -> ViewPackageCatalog
  -> runViewPackageConformance(environment + fixtures)
```

A Renderer is a human projection descriptor. A Method is an Agent affordance
that references an existing Core Operation or exact Transformation. Both are
resolved against the same exact View Schema; neither creates another data
universe.

A Processor declares how one output View family can be formed from one or more
input View roles. Its `View[] -> View` meaning lives in an exact immutable
Transformation. A Parser is the narrower discovery profile for turning one exact
source View into a committed, bounded search projection. Search never invokes a
Parser while serving a query. The manifest carries neither implementation code
nor runtime configuration: Execution validates and commits the output, while a
Function, Agent, workflow, service, human, or III Worker may host the Operator.

Renderer implementations are registered and checked by the exact
`id@version@abi_version` identity. `abi_version` is mandatory; older manifests
must be migrated explicitly because assuming an ABI would hide incompatible
registrations. Optional `media_types` further constrain selection when a
Representation declares a media type. The manifest never contains module
entrypoints, URLs, executable code, or host permissions.
