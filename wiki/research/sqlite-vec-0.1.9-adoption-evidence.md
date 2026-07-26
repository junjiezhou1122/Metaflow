---
name: research/sqlite-vec-0.1.9-adoption-evidence
title: sqlite-vec 0.1.9 Adoption Evidence
desc: Exact issue 67 gate evidence for the pinned Node 24 SQLite semantic Search adapter.
category: implementation-evidence
tags: [search, sqlite, sqlite-vec, vector, privacy-forget, reindex]
sources: [source-inspection, executable-tests, package-artifact]
created: 2026-07-27T09:00:00+08:00
updated: 2026-07-27T09:00:00+08:00
---

# sqlite-vec 0.1.9 Adoption Evidence

## Decision

The issue 67 adoption gate passed for exact-pinned `sqlite-vec@0.1.9`. The
production integration is limited to `packages/adapters/storage-sqlite`; there
is no LanceDB, in-memory cosine, remote vector service, document embedder, or
semantic fallback.

## Exact artifact

- npm package: `sqlite-vec@0.1.9`
- package integrity: `sha512-L7XJWRIBNvR9O5+vh1FQ+IGkh/3D2AzVksW5gdtk28m78Hy8skFD0pqReKH1Yp0/BUKRGcffgKvyO/EON5JXpA==`
- macOS arm64 binary: `sqlite-vec-darwin-arm64@0.1.9`
- runtime extension: `vec_version() = v0.1.9`
- inspected extension commit from `vec_debug()`: `e9f598abfa0c06b328d8fe5da9c3760cce74be10`
- executable runtime contract: Node `24.x`; the recorded acceptance host was
  Node `v24.14.0`, SQLite `3.51.2`, macOS arm64, WAL
- lockfile also freezes the upstream-published Darwin x64, Linux x64/arm64,
  and Windows x64 optional binary packages at `0.1.9`; no install script builds
  an unpinned local extension.

## Executed gates

`pnpm test:view-search-semantic` proves:

1. exact package path and extension version load through Node 24 `node:sqlite`;
2. required vector functions, SQLite minimum version, FTS5, WAL, exact profile,
   provider/model, dimension, metric, and persisted table declaration;
3. same-connection FTS, relation, and prefiltered `vec0` retrieval;
4. `BEGIN IMMEDIATE` rollback leaves no View, mapping, or vector from a failed
   two-embedding batch;
5. deletion, Privacy Forget downstream closure, and WAL reopen remove governed
   target and embedding evidence while unrelated results survive;
6. durable idempotent reindex repairs missing mappings and orphan `vec0` rows
   from committed embedding Views without calling an embedder;
7. identical exact semantic result and evidence envelopes across in-process,
   CLI, HTTP, and the real MCP SDK surface;
8. `pnpm verify:semantic-deploy` creates a production-only
   `pnpm deploy --prod --legacy` artifact, rejects dev dependencies, loads
   `v0.1.9` from the current host's deployed binary package, and verifies that
   the owning adapter ships the complete upstream MIT notice;
9. two profiles may both use physical rowid `1` without cross-resolving, while
   corrupted physical profile/target metadata fails both live query and reopen;
10. embedding policy cannot weaken visibility, privacy, retention, model,
    embedding/search flags, labels, or owner, and both same-batch target orders
    retain atomic forward-reference and rollback behavior.

The supported published binary tuples are Darwin arm64/x64, Linux arm64/x64,
and Windows x64. The lockfile pins all five at `0.1.9`; an acceptance run proves
only its reported current tuple, never unexecuted operating systems.

The representative local fixture contains 512 exact targets and 512 strict
32-dimensional embedding Derived Views. The acceptance run on 2026-07-27
measured 1,086.58 ms for atomic embedding commits, 51.62 ms for a prefiltered
semantic query, and 10,990,288 bytes across the SQLite database and active WAL.
The executable guard
is intentionally generous across CI: under 10 seconds to index, under 2 seconds
to query, and under 32 MiB.

The independent-review repair run added three semantic regressions and passed
Search `29/29`, View Store `12/12`, Privacy Forget/Capture `20/20`, the v1
vertical, typecheck, dependency/package boundaries, frozen-lockfile install,
and the production deploy verifier. The exact 48-file concurrent full-suite
runner passed twice (`391` passed, one intentional live Screenpipe skip, zero
failures on each run). The previously reported concurrent-worker
`search-adapter.js` resolution error did not reproduce in either clean run, so
no serialization or module-resolution fallback was added.

The final fail-fast regression deletes one committed embedding mapping and
adds an unrelated physical-only vec row before reopen. Startup exposes exact
orphan/missing counts as `reindex_required`; target-scoped Search returns a
typed retrieval failure rather than an empty hit set, and semantic insert and
delete are blocked. A new durable reindex repairs both rows and clears
maintenance only after commit, after which exact retrieval succeeds.
After rebasing onto integration commit `170ae655`, the final 49-file concurrent
suite passed with 403 tests, one intentional live Screenpipe skip, and zero
failures alongside the focused semantic, View Store, Forget, vertical,
typecheck, boundary, frozen-install, and production-deploy gates.

The final integrity repair makes committed strict, policy-eligible embedding
Views the authoritative expected set rather than treating mappings as the
inventory. A regression removes both the mapping and physical row, reopens in
`reindex_required` with one honest missing count, rejects an older successful
run, and proves a new durable reindex reconstructs the exact evidence. A second
regression corrupts physical metadata through a live connection: the detecting
Search fails with `vector_mapping_corrupt`, maintenance latches before return,
all later semantic reads/writes and stale replay stay blocked, and only the new
committed reindex clears the state. On Node `v24.14.0`, the final focused run
passed `16/16`; the 49-file full runner passed `405` with one intentional live
Screenpipe skip and zero failures. View Store passed `12/12`, Privacy
Forget/Capture `20/20`, and deploy, vertical, typecheck, dependency boundaries,
23 boundary regressions, and frozen-lockfile installation also passed.

The payload-integrity repair additionally treats each committed embedding
vector as canonical IEEE-754 float32 little-endian bytes. Startup and live
retrieval compare the bounded physical `vec0` blob directly with bytes derived
from the exact committed View, without trusting mapping metadata or a mutable
digest. Replacing `[1,0,0]` with `[0,0,1]` now latches
`reindex_required`, blocks semantic mutation and stale replay across reopen,
and a new durable reindex restores the exact bytes without changing View refs.
The regression also corrupts mapping path/digest and vector payload together;
both metadata and payload mismatches remain observable before repair.
The final Node `v24.14.0` run passed semantic `17/17`, the 49-file suite with
`406` passed and one intentional live Screenpipe skip, deploy, View Store
`12/12`, Privacy Forget/Capture `20/20`, vertical, typecheck, dependency and
test boundaries, and frozen-lockfile installation.

## Failure behavior

A database with stored vector profiles refuses to reopen without the same
semantic configuration. Extension/profile/version/dimension/metric/table
incompatibility or cross-profile physical metadata fails initialization.
Missing mappings, missing physical rows, loss of both rows, physical orphans,
and physical payload mismatches instead open in an explicit
`reindex_required` maintenance state so only a new durable reindex can proceed.
Invalid embedding provenance, policy,
target location, digest, or vector fails the whole View transaction. An
unconfigured `SearchService` still returns the existing explicit
`semantic_not_configured` outcome under partial mode or fails `require_all`;
it never substitutes another retriever.

## License and source

Metaflow redistributes sqlite-vec under the upstream MIT option. The complete
notice is `packages/adapters/storage-sqlite/THIRD_PARTY_NOTICES.md`, copied from
[`LICENSE-MIT`](https://github.com/asg017/sqlite-vec/blob/e9f598abfa0c06b328d8fe5da9c3760cce74be10/LICENSE-MIT)
at exact `v0.1.9` source commit `e9f598abfa0c06b328d8fe5da9c3760cce74be10`.
