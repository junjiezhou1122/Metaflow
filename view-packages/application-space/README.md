# Application Space View Package

An Application Space is an ordinary immutable Derived View. Its strict
`application.space@1` Representation freezes exact entry revisions and declares
whether each entry participates through membership or structural composition.

The Application Space root owns outgoing `application_member` and
`application_composition` relations to those exact entries. The same member can
therefore be targeted by several independently versioned roots without being
copied or reparented.

Attach and detach are ordinary View evolution. Commit a new revision of the
same root, add the exact `supersedes` relation to the prior root revision, and
replace both the Representation entry set and its package relations. Historical
root revisions and their exact membership remain immutable; detaching never
deletes or revises a member View.

Use `view.graph.project` for bounded authorized navigation and `view.get` for
full details of one selected exact revision. A projection response is transport
data, not another durable View.
