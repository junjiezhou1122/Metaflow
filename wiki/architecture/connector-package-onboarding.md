---
name: architecture/connector-package-onboarding
title: Connector Package and Source Connection Onboarding
desc: Canonical trust, installation, configuration, verification, preview, activation, and run boundary for external information sources.
category: canonical-decision
tags: [connector, capture, package, trust, onboarding, notion]
sources: [github/issue-77, airbyte-protocol, meltano-plugins, notion-sdk-js]
created: 2026-07-27T12:00:00+08:00
updated: 2026-07-27T12:00:00+08:00
---

# Connector Package and Source Connection Onboarding

Metaflow has two separate extension objects:

- a **Connector Package** is installable, trusted executable capability;
- a **Source Connection** is one user's configured instance of that package.

Neither is a View Package. A View Package defines how Views are understood,
processed, searched, rendered, and operated. A Connector Package only gets
external evidence to `RawViewCandidate`; Capture Runtime remains the sole path
that admits it as Raw Views.

```text
package catalog
  descriptor(id@version + sha256, ABI, signature, permissions,
             credential slots, config schema, conformance@2)
       ↓ exact trusted loader
provider adapter / official SDK
       ↓
Source Connection draft@1
       ↓ check
checked@2 ── discover preview (no View, no checkpoint)
       ↓ activate
active@3 ── run ── ConnectorRuntime ── CaptureIngress ── Raw Views
       ├── pause -> paused@4
       └── update -> draft@4 -> check -> activate
```

Every mutation is compare-and-swap on `expected_generation`; a stale caller
cannot overwrite a newer configuration. Every lifecycle request has an
idempotency key. Exact replay returns its durable receipt; changed input under
the same key fails.

Secrets are a map of declared names to references:

```json
{
  "notion_token": { "provider": "env", "key": "NOTION_TOKEN" }
}
```

The descriptor determines required names and accepted secret providers.
Inline token values remain invalid everywhere.

## Trust decision

The loader returns executable Connector code only after all checks pass:

1. exact `id@version+sha256` exists and resolves uniquely;
2. descriptor has an Ed25519 publisher signature;
3. publisher key is trusted by the host;
4. artifact bytes match the frozen sha256 digest;
5. that inspected artifact, rather than a second package lookup, is instantiated;
6. implementation and Connector manifest match the signed descriptor;
7. Runtime ABI is supported;
8. every requested permission is in the host allowlist.

Unknown, ambiguous, unsigned, altered, incompatible, untrusted, and
over-privileged artifacts are distinct observable failures. There is no
in-process marketplace fallback.

The v7 SQLite migration converts only the lossless legacy case
`secret_refs: []` to `{}`. A non-empty positional array has no
provider-neutral credential slot name, so startup fails with the connection id,
table, migration phase, and transaction evidence instead of guessing.

## Notion vertical

The first SaaS vertical uses `@notionhq/client@5.4.0`, including the official
full-result type guard. `discover` is a bounded search preview. `run` preserves
full Notion page/data-source JSON as one stable-source Raw View. Cover, file,
and image URLs remain external source references; the adapter does not download
large media. The `notion_token` reference is resolved only at SDK construction.

## Reused patterns

- Airbyte: familiar spec/check/discover/read source lifecycle and explicit
  state/checkpoint evidence.
- Meltano/Singer: catalog and exact plugin variant discovery.
- Notion SDK: official client, typed endpoints, and full/partial response guards.

Metaflow does not adopt their storage model. Exact View identity, policy,
provenance, atomic Capture admission, retry, checkpoint, DLQ, and trace remain
owned by existing Metaflow packages.
