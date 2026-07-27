# Markdown Parser Adapter

`@info/markdown-parser-adapter` is the deterministic first Parser Worker
implementation. It converts one exact inline Markdown View into bounded,
location-aware fragments and wraps them in an untrusted
`metaflow.view.fragment-set@1` candidate.

The adapter never commits Views, writes an index, computes embeddings, fetches
external references, or runs during a Search query. Register
`executeMarkdownParser` as the exact `parser.markdown@1` Function Operator;
`ExecutionRuntime` remains responsible for authorization, candidate validation,
provenance, policy inheritance, Run state, and atomic commit.

Parser limits are frozen in the Operator configuration. CPU parsing runs in a
terminable Worker Thread so the frozen Transformation timeout and active Run
cancellation remain enforceable. Unsupported Representations, malformed AST
locations, and byte or fragment limit violations throw
`OperatorExecutionFailure` and become typed terminal Run failures through the
Function Operator adapter. Unknown Worker failures remain crashes, and content
is never included in diagnostics.
