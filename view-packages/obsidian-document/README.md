# Obsidian Document View Package

This declarative package owns the `capture.obsidian.document@1` View family and
advertises the exact `parser.markdown@1` capability through
`transformation.parser.markdown@1`.

The package contains no executable Parser, Worker connection, queue, budget,
filesystem path, or vault credential. The Markdown Parser adapter implements the
Operator, Execution validates and commits its candidate, and Search reads only
the committed fragment-set projection.
