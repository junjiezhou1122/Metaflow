---
ticket: ../tickets/choose-capability-owners.md
type: wayfinder-resolution
resolved: 2026-07-25
---

# Resolution: Choose the top-level capability owners

Metaflow v1 packages are organized by stable capability ownership rather than
by v0 pipeline stage, model, vendor, or deployment technology.

Reusable adapters are packages too. Their directory and dependency role make
the distinction explicit:

```text
packages/
|- <capability owners>
|- adapters/<technology adapter packages>
`- surfaces/<transport projection packages>

apps/
`- <deployable composition roots>
```

Domain packages declare ports and invariants. Adapter packages depend on and
implement those ports. Apps compose capabilities and adapters. A domain
package must not depend on SQLite, III, Multica, Screenpipe, or a transport
surface.

The exact owner list remains revisable as the remaining architecture tickets
resolve, but this ownership and dependency rule is fixed for the map.
