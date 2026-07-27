# Structured Content View Package

This declarative package owns strict JSON document, table, property graph, and
external-reference View families. Each family advertises one exact-versioned
Parser Transformation that produces a committed `metaflow.view.fragment-set@2`
Derived View before Search can consume its contents.

The package performs no parsing, source I/O, URI fetch, graph persistence, or
Search indexing. Executable Parser Workers live in
`@info/structured-parser-adapter`; Execution validates and atomically commits
their untrusted candidates.
