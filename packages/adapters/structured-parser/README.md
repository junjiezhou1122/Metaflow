# Structured Parser Adapter

`@info/structured-parser-adapter` hosts the exact `parser.json@1`,
`parser.table@1`, `parser.graph@1`, and `parser.external-reference@1` Function
Operators. They accept one frozen exact View, run bounded CPU projection in a
terminable Worker Thread, and return an untrusted strict
`metaflow.view.fragment-set@2` candidate for ordinary Execution validation and
atomic commit.

The JSON Parser records RFC 6901 pointers. The table Parser records row and
column coordinates. The graph Parser records node or edge identity plus exact
property pointers while keeping the original graph in its source View. The
external-reference Parser indexes only the committed URI and retained metadata;
it verifies a matching URI Materialization descriptor and never performs I/O.

This adapter does not own Transformations, commit Views, write indexes, fetch
references, create a graph store, or execute on the Search query path.
