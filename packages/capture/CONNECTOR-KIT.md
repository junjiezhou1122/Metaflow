# Connector Kit Authoring Contract

Use Connector Kit when adding one external information source. The source
adapter owns authentication, SDK/API calls, webhook or native event handling,
pagination, and source-specific error classification. Connector Kit owns only
strict source validation and deterministic adaptation into canonical Capture
candidates and batches.

## Minimal template

```ts
import { z } from "zod";
import { defineConnectorKit } from "@info/capture";

const Configuration = z.object({ account_id: z.string() }).strict();
const Payload = z.object({
  event_id: z.string(),
  occurred_at: z.string().datetime({ offset: true }),
  source_fields: z.record(z.unknown()),
}).strict();

export const SOURCE_KIT = defineConnectorKit({
  manifest: {
    id: "source-id",
    version: "1.0.0",
    display_name: "Source Name",
    protocols: ["webhook"],
    capabilities: ["event"],
    delivery_kinds: ["push"],
    emitted_schemas: [
      { name: "capture.source.event", version: 1, mode: "freeform" },
    ],
  },
  configuration_schema: Configuration,
  payload_schema: Payload,
  adapt(payload, context) {
    return [{
      idempotency_key: `source:${payload.event_id}`,
      name: `Source event ${payload.event_id}`,
      purpose: "Preserve one source event",
      schema: { name: "capture.source.event", version: 1, mode: "freeform" },
      source: context.occurrence({
        source_id: payload.event_id,
        source_kind: "source_event",
      }),
      representation: {
        form: "inline",
        kind: "source_payload",
        value: payload,
        metadata: {},
      },
    }];
  },
});
```

Choose `context.stableSource` only when later source observations revise the
same external object. Choose `context.occurrence` for a click, copy, watch
session, webhook delivery, or other event that must retain an independent View
identity. These choices are never inferred by the Kit.

SourceConnection configuration contains non-secret settings only. Credentials
must use `secret_refs` or `secretReference`; they cannot appear in endpoint,
configuration, Representation, metadata, errors, or traces. Candidate policy
inherits the complete SourceConnection policy by default. A full candidate
policy may tighten it but cannot change owner or weaken visibility, privacy,
retention, external-model, embedding, local-search, or required-label
constraints.

An emitted Schema may declare `search_projection@1`. Connector Adapt retains
the source-native Representation; the projection only names deterministic
scalar fields that a local index may copy. It never asks Adapt to summarize,
decode media, call a model, or embed content.

Keep accepted source fields in the Raw View Representation or an explicit
external reference. OCR, transcription, summarization, classification,
embedding, large-media fetch, and semantic restructuring are later
Transformations, not Adapt behavior.

Every Connector test must call `runConnectorConformance` with valid cases,
malformed payloads, expected Schema versions and candidate counts, a lossless
assertion, and a submit callback that crosses the real Capture Runtime. The
same payload is submitted twice and must resolve to the same exact View refs.

See `packages/adapters/clipboard-capture` for the smallest complete example.
Browser and Screenpipe intentionally retain their source-specific lifecycle,
transport, health, pagination, and cursor code outside this Kit.
