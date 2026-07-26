# View Package

`@info/view-package` is the authoring and discovery module for coherent View
capabilities. A package declares Schema versions, accepted Representations,
Materialization profiles, human Renderer descriptors, Agent Methods, and
explicit Schema evolutions in one fail-fast manifest.

The module owns manifest validation, exact reference checks, catalog conflict
detection, discovery, and conformance. It does not execute Renderers, read or
write SQLite, invoke Operators, expose transports, or migrate stored Views.
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
