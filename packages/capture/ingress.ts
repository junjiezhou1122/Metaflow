import { createHash, randomUUID } from "node:crypto";
import { parseViewDraft, type View, type ViewDraft, type ViewRepository } from "@info/view";
import {
  CaptureBatchSchema,
  CaptureValidationError,
  ObservationCandidateSchema,
  type CaptureBatch,
  type CaptureCheckpoint,
  type CaptureEvent,
  type IngestReceipt,
  type ObservationCandidate,
  type SourceConnection,
} from "./contracts.js";
import { safeCaptureError } from "./errors.js";
import type { CaptureRuntimeRepository, CommitCaptureBatchResult, PreparedCaptureCommit } from "./runtime-contracts.js";

export type CaptureIngressRepository = ViewRepository & Partial<CaptureRuntimeRepository>;

export type CaptureIngressOptions = {
  repository: CaptureIngressRepository;
  now?: () => string;
  idFactory?: (candidate: ObservationCandidate) => string;
  traceIdFactory?: () => string;
  onEvent?: (event: CaptureEvent) => void | Promise<void>;
};

function defaultIdFactory(candidate: ObservationCandidate): string {
  const identity = candidate.source.identity === "stable_source"
    ? [
        candidate.source.connector,
        candidate.source.connection_id,
        candidate.source.source_kind,
        candidate.source.source_id,
        candidate.source.identity,
      ].join(":" )
    : candidate.idempotency_key;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `view:raw:${digest}`;
}

export class CaptureIngress {
  private readonly now: () => string;
  private readonly idFactory: (candidate: ObservationCandidate) => string;
  private readonly traceIdFactory: () => string;
  private readonly onEvent?: (event: CaptureEvent) => void | Promise<void>;

  constructor(private readonly options: CaptureIngressOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.traceIdFactory = options.traceIdFactory ?? randomUUID;
    this.onEvent = options.onEvent;
  }

  async ingest(input: unknown): Promise<IngestReceipt> {
    const parsed = ObservationCandidateSchema.safeParse(input);
    if (!parsed.success) {
      throw new CaptureValidationError("invalid Observation candidate", parsed.error.issues);
    }
    const candidate = parsed.data;
    const baseEvent = {
      at: this.now(),
      connector: candidate.source.connector,
      connection_id: candidate.source.connection_id,
      source_id: candidate.source.source_id,
      idempotency_key: candidate.idempotency_key,
    } as const;
    await this.emit({ type: "capture.started", ...baseEvent });
    try {
      if (candidate.policy.retention === "do_not_store") {
        await this.emit({ type: "capture.skipped", ...baseEvent });
        return { status: "skipped", reason: "do_not_store", idempotency_key: candidate.idempotency_key };
      }

      const draft = await this.toDraft(candidate, this.traceIdFactory());
      const result = await this.options.repository.commit({
        draft,
        expected_revision: 0,
        idempotency_key: candidate.idempotency_key,
      }, {
        batch_id: candidate.idempotency_key,
        committed_at: draft.time.created_at,
        origin: { kind: "capture", id: candidate.source.connection_id },
      });
      await this.emit({
        type: "capture.committed",
        ...baseEvent,
        view_id: result.view.id,
        revision: result.view.revision,
      });
      return { status: "stored", view_id: result.view.id, revision: result.view.revision, created: result.created };
    } catch (error) {
      const safe = safeCaptureError(error);
      await this.emit({ type: "capture.failed", ...baseEvent, error: { code: safe.code, message: safe.message } });
      throw error;
    }
  }

  async ingestBatch(input: {
    batch: CaptureBatch;
    connection: SourceConnection;
    checkpoint: CaptureCheckpoint;
    attempt: number;
  }): Promise<CommitCaptureBatchResult> {
    const parsed = CaptureBatchSchema.safeParse(input.batch);
    if (!parsed.success) throw new CaptureValidationError("invalid Capture Batch", parsed.error.issues);
    for (const candidate of parsed.data.candidates) {
      await this.emit({
        type: "capture.started",
        at: this.now(),
        connector: candidate.source.connector,
        connection_id: candidate.source.connection_id,
        source_id: candidate.source.source_id,
        idempotency_key: candidate.idempotency_key,
      });
    }

    try {
      const repository = this.options.repository as CaptureIngressRepository;
      if (typeof repository.commitCaptureBatch !== "function") {
        throw new TypeError("CaptureIngress batch admission requires a CaptureRuntimeRepository");
      }
      const traceId = this.traceIdFactory();
      const commits: PreparedCaptureCommit[] = [];
      const skipped: Array<{ candidate_index: number; receipt: Extract<IngestReceipt, { status: "skipped" }> }> = [];
      for (let index = 0; index < parsed.data.candidates.length; index += 1) {
        const candidate = parsed.data.candidates[index]!;
        if (candidate.policy.retention === "do_not_store") {
          skipped.push({
            candidate_index: index,
            receipt: { status: "skipped", reason: "do_not_store", idempotency_key: candidate.idempotency_key },
          });
          continue;
        }
        const viewId = this.idFactory(candidate);
        const latest = candidate.source.identity === "stable_source"
          ? await repository.getLatest(viewId)
          : undefined;
        commits.push({
          candidate_index: index,
          commit: {
            draft: await this.toDraft(candidate, traceId, latest),
            expected_revision: latest?.revision ?? 0,
            idempotency_key: candidate.idempotency_key,
          },
        });
      }
      const result = await repository.commitCaptureBatch({
        connection: input.connection,
        batch: parsed.data,
        attempt: input.attempt,
        commits,
        skipped,
        checkpoint: input.checkpoint,
        completed_at: this.now(),
      });
      for (let index = 0; index < result.receipts.length; index += 1) {
        const receipt = result.receipts[index]!;
        const candidate = parsed.data.candidates[index]!;
        if (receipt.status === "stored") {
          await this.emit({
            type: "capture.committed",
            at: this.now(),
            connector: candidate.source.connector,
            connection_id: candidate.source.connection_id,
            source_id: candidate.source.source_id,
            idempotency_key: candidate.idempotency_key,
            view_id: receipt.view_id,
            revision: receipt.revision,
          });
        } else {
          await this.emit({
            type: "capture.skipped",
            at: this.now(),
            connector: candidate.source.connector,
            connection_id: candidate.source.connection_id,
            source_id: candidate.source.source_id,
            idempotency_key: candidate.idempotency_key,
          });
        }
      }
      return result;
    } catch (error) {
      const safe = safeCaptureError(error);
      for (const candidate of parsed.data.candidates) {
        await this.emit({
          type: "capture.failed",
          at: this.now(),
          connector: candidate.source.connector,
          connection_id: candidate.source.connection_id,
          source_id: candidate.source.source_id,
          idempotency_key: candidate.idempotency_key,
          error: { code: safe.code, message: safe.message },
        });
      }
      throw error;
    }
  }

  private async toDraft(candidate: ObservationCandidate, traceId: string, latest?: View): Promise<ViewDraft> {
    const relations = latest
      ? [
          ...candidate.relations,
          { type: "supersedes", target: { view_id: latest.id, revision: latest.revision }, metadata: {} },
        ]
      : candidate.relations;
    const materialization = candidate.representation.form === "external_reference"
      ? {
          primary: {
            id: "source-reference",
            format: "reference",
            media_type: candidate.representation.media_type ?? "application/octet-stream",
            location: { kind: "uri" as const, uri: candidate.representation.uri },
            ...(candidate.representation.digest ? { digest: candidate.representation.digest } : {}),
          },
          alternatives: [],
        }
      : {
          primary: {
            id: "canonical-json",
            format: "json",
            media_type: candidate.representation.media_type ?? "application/json",
            location: { kind: "inline" as const },
          },
          alternatives: [],
        };
    return parseViewDraft({
      id: this.idFactory(candidate),
      name: candidate.name,
      purpose: candidate.purpose,
      aliases: candidate.aliases,
      schema: candidate.schema,
      role: "raw",
      time: {
        ...(candidate.observed_at ? { observed_at: candidate.observed_at } : {}),
        created_at: candidate.captured_at,
      },
      representation: candidate.representation,
      materialization,
      relations,
      provenance: {
        inputs: [],
        capture: candidate.source,
        actor: "capture-ingress",
        trace_id: traceId,
      },
      policy: candidate.policy,
      metadata: candidate.metadata,
    });
  }

  private async emit(event: CaptureEvent): Promise<void> {
    if (this.onEvent) await this.onEvent(event);
  }
}

export function createCaptureIngress(options: CaptureIngressOptions): CaptureIngress {
  return new CaptureIngress(options);
}
