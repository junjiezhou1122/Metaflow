## Question

How should a versioned Transformation freeze its instruction, Operator, inputs, output contract, trigger, policy, and budget while remaining natural-language and AI extensible?

## Depends on

- Implement the minimum immutable View contract

## Acceptance criteria

- Transformation has stable id and immutable revision.
- Instruction and Operator snapshot are required before execution.
- Operator supports Agent, Workflow, function, model, human, and remote-service references without a Worker entity.
- Explicit input revisions or an input selector are supported.
- Output Schema may be supplied or inferred, but is frozen before execution.
- Trigger, policy, and budget are optional, versioned fields.
- One Operator may serve many Transformations; one View may be targeted by many Transformations.

## Verification method

- Unit-test every Operator kind, one-off natural-language snapshots, revision changes, invalid mutable fields, and serialization round trips.
