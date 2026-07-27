# Function Operator Adapter

`@info/function-operator-adapter` binds exact
`{ function_id, version }` references to deterministic in-process
implementations of `OperatorExecutionPort`.

Implementations receive the same frozen invocation, abort signal, and durable
event sink as every other Operator. They return an untrusted candidate
envelope. `ExecutionRuntime`, not the adapter, validates output cardinality,
Schema, policy, provenance, base revision, and commits the terminal transaction.

Registration is exact-versioned and duplicate keys fail immediately. A new
split, merge, grouping, compression, or user-created function requires only a
new registration; it does not add a View Core type or fixed semantic taxonomy.

`FunctionOperatorAdapter` emits `function.started`, `function.completed`,
`function.failed`, and `function.cancelled` events through the Run trace.
Implementations may throw `OperatorExecutionFailure` from `@info/execution` to
return a typed terminal failure without losing the implementation error code;
unexpected exceptions remain observable `operator_crashed` failures.
`OperatorExecutionRouter` in `@info/execution` composes it with Agent, Workflow,
model, human, and remote-service ports in one Runtime instance.
