---
name: research/view-search-landscape
title: View Search Landscape
desc: External evidence for heterogeneous parsing, hybrid retrieval, scoped Wiki search, and graph-aware retrieval relevant to Metaflow.
category: framework-evaluation
tags: [search, retrieval, rag, wiki, parser, vector, graph]
sources: [github, project-documentation]
created: 2026-07-26T14:57:38Z
updated: 2026-07-26T14:57:38Z
---

# View Search Landscape

> Status: external evidence and design references, not an adoption decision.
> Project behavior and licensing should be reverified at a pinned revision
> before adding a dependency or copying code.

## Research question

Metaflow needs to search heterogeneous View Representations at several levels:
the View envelope, internal content, selected child Views, and a relation-based
subgraph. This review asks which existing projects already solve useful parts
of that problem without replacing Metaflow's View identity, exact revision,
policy, and provenance model.

## Comparison

| Project | Useful mechanism | Fit for Metaflow | Main constraint |
|---|---|---|---|
| [Plasma Wiki](https://github.com/plasma-ai/wiki) | Hierarchical `_index.md`, subtree scope, regex search, explicit page reads | Strong Wiki navigation and authoring reference | Not a semantic or recursive View runtime |
| [DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open) | Code chunking, embeddings, FAISS retrieval | Small vector-search prototype | Flattens recursive identity and provenance into chunks |
| [OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) | Routes by repository metadata and Wiki titles before scoped document search | Evidence for scope-first retrieval | Domain remains repository/Wiki specific |
| [Unstructured](https://github.com/Unstructured-IO/unstructured) | Format-specific partitioners normalize files into common Elements | Strong narrow Parser Adapter candidate | File ETL, not Metaflow identity or lifecycle |
| [LlamaIndex](https://github.com/run-llama/llama_index) | Reader, Document, Node Parser, Index, Retriever, Query Engine pipeline | Optional parser and Retriever implementations | Its Document and Node must not become Core objects |
| [RAGFlow](https://github.com/infiniflow/ragflow) | Format-aware parsing, hybrid keyword/vector scoring, reranking, citations, optional graph | Strong fusion and citation reference | Full platform is too broad to adopt as Metaflow Core |
| [Khoj](https://github.com/khoj-ai/khoj) | Per-source processors, normalized entries, vector retrieval, cross-encoder reranking | Strong personal knowledge UX reference | AGPL-3.0 requires careful reuse review |
| [Microsoft GraphRAG](https://github.com/microsoft/graphrag) | Entity entry points, relation expansion, source chunks, community reports | Strong subgraph and global-summary retrieval reference | Expensive AI-built graph, not a primary evidence store |
| [LangChain Open Deep Research](https://github.com/langchain-ai/open_deep_research) | Agent-orchestrated Web/MCP research, compression, and report writing | Agent Operator reference above Search | It is not a Wiki indexer or Search Core |

## Plasma Wiki

Plasma Wiki's useful idea is hierarchical scope. `_index.md` pages describe a
directory, search can be constrained to a path or subtree, and content is read
explicitly after discovery. This maps well to Metaflow Wiki management and to
the intuition that an Application Space or View subgraph should be a first-class
search scope.

It does not provide heterogeneous Representation parsing, immutable View
revisions, semantic retrieval, relation traversal, or policy-governed Derived
Views. Metaflow should use it to manage this Wiki, not as its data runtime.

License observed in the repository: Apache-2.0.

## DeepWiki variants

[DeepWiki-Open](https://github.com/AsyncFuncAI/deepwiki-open) demonstrates a
minimal conventional vector path: code is split into overlapping text chunks,
embedded, stored in FAISS, and retrieved with a fixed top-k. This is useful for
testing a Retriever Adapter, but its chunks do not preserve Metaflow's
recursive View semantics by themselves.

[OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) first uses repository
and Wiki metadata to narrow the relevant area, then searches the scoped
documentation. That validates a key Metaflow decision:

```text
resolve authorized scope
    -> search eligible content within that scope
```

Observed licenses: MIT for both repositories.

## Unstructured

Unstructured is a file-oriented extraction and transformation library. It
routes PDF, HTML, DOCX, PPTX, image, and other formats to specialized
partitioners and emits a common Element vocabulary such as titles, narrative
text, tables, and images.

This is the closest match for a narrow heterogeneous Parser Adapter:

```text
exact external-reference View
    -> Unstructured-backed Operator
    -> extracted Derived View with provenance
```

Metaflow should not let Unstructured Elements replace Views. Fetching and
partitioning remain an explicit Transformation so the extracted result has an
exact identity, policy, provenance, and failure trace.

Observed license: Apache-2.0.

## LlamaIndex

LlamaIndex separates ingestion and retrieval into a useful pipeline:

```text
Reader -> Document -> Node Parser -> Nodes -> Index -> Retriever -> Query Engine
```

Its Readers, Node Parsers, indexes, Retrievers, and rerankers are plausible
adapter implementations. The abstraction boundary is important: `Document`
and `Node` are LlamaIndex runtime objects, while the Metaflow boundary accepts
and returns exact View references and records any semantic derivation as a
Transformation.

Observed license: MIT.

## RAGFlow

RAGFlow is the closest full NotebookLM-style system in this set. It combines
format-specific parsers and task-specific chunking with keyword and vector
retrieval, score fusion, optional reranking, citations, and graph-related
features.

The useful lesson is architectural rather than wholesale adoption:

```text
several compatible parsers
    -> normalized searchable units
    -> keyword and vector retrievers
    -> visible score fusion and reranking
    -> cited evidence
```

Metaflow needs the same replaceability while retaining exact View revisions
and relation paths. Adopting RAGFlow as Core would also adopt a much larger RAG
platform, storage model, and operational surface.

Observed license: Apache-2.0.

## Khoj

Khoj is a strong personal knowledge-product reference. Markdown, PDF, Notion,
GitHub, and image sources have source-specific processors that normalize content
into searchable entries. Retrieval uses a bi-encoder to find candidates and a
cross-encoder to rerank them.

This validates the many-parser, shared-retrieval pattern and provides useful UX
evidence for searching personal information. Its normalized Entry should remain
an adapter object rather than replacing a View.

Observed license: AGPL-3.0. Source copying or network-service integration needs
an explicit licensing review.

## Microsoft GraphRAG

GraphRAG adds a relation-aware path beyond conventional RAG. Local search finds
semantically relevant entities, expands through relationships, and gathers
associated source chunks and community reports. Global search uses community
reports through a map-reduce style process.

This is the strongest reference for two Metaflow query shapes:

```text
local:  semantic entry View -> bounded relation expansion -> source evidence
global: selected subgraphs -> summaries -> aggregated answer
```

GraphRAG builds entities, relations, and reports with models. They are derived
interpretations, not raw facts. In Metaflow they would therefore be Derived
Views with explicit provenance, cost, version, and policy.

Observed license: MIT.

## LangChain Open Deep Research

Open Deep Research is an Agent workflow. It searches Web or MCP sources,
summarizes and compresses evidence, and writes a report. It does not provide a
general heterogeneous Wiki index or the persistent recursive View model.

Its correct Metaflow location is above Search:

```text
Agent Operator
    -> calls Metaflow Search repeatedly
    -> selects exact View evidence
    -> commits a report as a Derived View
```

## Recommended composition

No single reviewed project should own Metaflow Search. The useful composition
is:

```text
Canonical truth          -> Metaflow View and exact relations
Parser layer             -> selectively use Unstructured
RAG components           -> optional LlamaIndex adapters
Hybrid retrieval lessons -> learn from RAGFlow
Personal search UX       -> learn from Khoj
Graph retrieval          -> learn from GraphRAG
Wiki navigation          -> keep using Plasma Wiki
Research workflows       -> Agent Operators such as Open Deep Research
```

The dependency decision should be made per adapter after a pinned-version API,
platform, performance, privacy, and license evaluation. The first prototype
should prove one real heterogeneous, scoped, policy-governed View search rather
than installing an entire RAG platform.

## Sources

- [Plasma Wiki repository](https://github.com/plasma-ai/wiki)
- [DeepWiki-Open repository](https://github.com/AsyncFuncAI/deepwiki-open)
- [OpenDeepWiki repository](https://github.com/AIDotNet/OpenDeepWiki)
- [Unstructured documentation](https://docs.unstructured.io/open-source/core-functionality/partitioning)
- [LlamaIndex documentation](https://docs.llamaindex.ai/en/stable/module_guides/)
- [RAGFlow retrieval component documentation](https://ragflow.io/docs/dev/retrieval_component)
- [Khoj repository](https://github.com/khoj-ai/khoj)
- [Microsoft GraphRAG query overview](https://microsoft.github.io/graphrag/query/overview/)
- [LangChain Open Deep Research repository](https://github.com/langchain-ai/open_deep_research)
