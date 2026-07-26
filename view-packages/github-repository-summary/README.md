# GitHub Repository Summary View Package

This is the first concrete View Package. It binds the existing
`summary.github.repository@1` Schema to its accepted Agent output,
Materialization profile, human Renderer descriptor, and Agent Methods.

The package does not implement the Renderer or execute the Transformation.
Hosts resolve `renderer.github.repository-summary`; Agents invoke the declared
Core Operations or the exact `transformation.github.repository_summary@1` via
the existing Operations and Execution modules.
