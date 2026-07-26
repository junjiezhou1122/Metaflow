## Question

How should the confirmed capability owners be established as buildable workspace packages without importing v0 ownership or creating cyclic dependencies?

## Depends on

- Lock the View Core and Transformation Runtime domain baseline

## Acceptance criteria

- Workspace packages exist for `view`, `transformation`, `execution`, and `capture`.
- Infrastructure implementations under `packages/adapters/*` are independent workspace packages.
- Apps compose capabilities without owning domain rules.
- Automated dependency checks reject `view -> runtime/adapter/app` and other forbidden directions.
- No empty abstraction package is introduced for Worker, marketplace, repair, policy, or View Algebra runtime.

## Verification method

- Run workspace typechecks and package-boundary tests.
- Inspect the dependency graph and demonstrate a failing fixture for one forbidden edge.
