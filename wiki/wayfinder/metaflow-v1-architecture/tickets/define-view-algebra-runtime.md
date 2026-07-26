---
title: Define the View Algebra and Operator Runtime boundary
type: wayfinder-ticket
label: wayfinder:grilling
parent: ../map.md
status: open
assignee: codex
blocked_by:
  - choose-capability-owners.md
---

# Define the View Algebra and Operator Runtime boundary

## Question

Which semantics belong to the AI-readable View Algebra contract, and which
selection, execution, authorization, validation, tracing, and retry behavior
belongs to the Operator Runtime?

## Current implementation boundary

`packages/view` now owns the first typed View Algebra expression and Operator
contract. An expression recursively contains View references and `apply`
nodes. The contract declares input/output schemas, lossiness, determinism, and
required capabilities. It does not select or execute an implementation.

Still open for the next slice:

- implementation registry and eligibility;
- policy and authorization before execution;
- durable Operator Run and attempt events;
- cancellation and long-running Agent/Workflow lifecycle;
- explicit retry and alternative implementation semantics;
- candidate output validation and commit transaction.

The ticket remains open until one real Operator, preferably `compress`, runs
through code and Agent implementations with the same contract and trace.
