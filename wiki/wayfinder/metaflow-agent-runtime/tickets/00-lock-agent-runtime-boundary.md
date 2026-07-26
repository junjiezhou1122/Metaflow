## Question

What is the binding boundary between Metaflow Execution Runtime, Agent Runtime,
external agent sessions, and durable Views?

## Acceptance Criteria

- Agent Runtime is defined as an Operator execution layer under
  Transformation Run.
- Agent sessions are explicitly non-authoritative runtime state; Views, Runs,
  traces, and Failure Views remain durable truth.
- The design records how Agent Runtime relates to ACP, Pi, Codex, workflow
  engines, and plain model/function Operators.
- The design rejects per-task hidden fallback from one agent runtime to
  another. Alternatives are explicit attempts with trace.
- The design preserves the no-separate-Worker-domain decision.

## Verification Method

- Review this map with `wiki/architecture/view-core-transformation-runtime.md`.
- Search canonical guidance for contradictory Worker, agent-memory, or
  always-cold-spawn ownership.
