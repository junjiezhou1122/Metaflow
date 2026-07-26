# Application Space View Package

An Application Space is an ordinary immutable Derived View. Its strict
`application.space@1` Representation freezes exact entry revisions and declares
whether each entry participates through membership or structural composition.

The Application Space root owns outgoing `application_member` and
`application_composition` relations to those exact entries. The same member can
therefore be targeted by several independently versioned roots without being
copied or reparented.

The strict Schema declares this mapping as `relation_projection@1`. View
admission and View Package conformance both require the Representation entry set
to match the managed relation set exactly, including exact ref, type, and
metadata. Missing, extra, mismatched, and whitespace-only-ref evidence fails
before persistence, as do leading or trailing spaces that exact-ref parsing
would otherwise normalize.

Attach and detach are ordinary View evolution. Commit a new revision of the
same root, add the exact `supersedes` relation to the prior root revision, and
replace both the Representation entry set and its package relations. Historical
root revisions and their exact membership remain immutable; detaching never
deletes or revises a member View.

Use `view.graph.project` for bounded authorized navigation and `view.get` for
full details of one selected exact revision. Projection pages and summaries are
read from one storage snapshot, and validated discoveries are authorized before
they consume the projection-wide server scan budget. File databases use a WAL
read transaction; in-memory repositories use an explicit query-only SQLite
memory backup. A projection response is transport data, not another durable
View.
