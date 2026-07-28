import {
  CaptureBatchSchema,
  CaptureCheckpointSchema,
  CaptureDeadLetterSchema,
  CaptureRetryPolicySchema,
  CaptureRuntimeError,
  CaptureSafeErrorSchema,
  CaptureValidationError,
  ConnectorHealthSchema,
  ConnectorManifestSchema,
  SourceConnectionSchema,
  type CaptureBatch,
  type CaptureDeadLetter,
  type CaptureDeliveryKind,
  type CaptureSafeError,
  type ConnectorHealth,
  type SourceConnection,
} from "./contracts.js";
import { safeCaptureError } from "./errors.js";
import { CaptureIngress } from "./ingress.js";
import type {
  CaptureRuntimeOptions,
  CaptureRuntimeRepository,
  CommitCaptureBatchResult,
  ConnectorOpenRequest,
  ConnectorPort,
} from "./runtime-contracts.js";

const DEFAULT_RETRY_POLICY = CaptureRetryPolicySchema.parse({
  id: "capture-retry:default",
  revision: 1,
  max_attempts: 3,
  retryable_codes: ["connector_protocol_error", "connector_crash", "storage_failure"],
  non_retryable_codes: [
    "capture_validation_failed",
    "idempotency_conflict",
    "source_identity_conflict",
    "checkpoint_conflict",
    "connection_paused",
    "backpressure",
  ],
});

export class ConnectorRuntime {
  private readonly connectors = new Map<string, ConnectorPort>();
  private readonly retryPolicy;
  private readonly maxInFlight: number;
  private readonly now: () => string;
  private readonly deadLetterId: (batch: CaptureBatch) => string;

  constructor(
    private readonly repository: CaptureRuntimeRepository,
    private readonly ingress: CaptureIngress,
    options: Partial<CaptureRuntimeOptions> = {},
  ) {
    this.retryPolicy = CaptureRetryPolicySchema.parse(options.retry_policy ?? DEFAULT_RETRY_POLICY);
    this.maxInFlight = options.max_in_flight ?? 1;
    if (!Number.isInteger(this.maxInFlight) || this.maxInFlight < 1) {
      throw new TypeError("ConnectorRuntime max_in_flight must be a positive integer");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.deadLetterId = options.dead_letter_id ?? (batch => `capture-dead-letter:${batch.id}`);
  }

  registerConnector(input: ConnectorPort): void {
    const manifest = ConnectorManifestSchema.parse(input.manifest);
    const key = connectorKey(manifest.id, manifest.version);
    if (this.connectors.has(key)) throw new CaptureRuntimeError(`Connector ${key} is already registered`, "connector_conflict", "runtime", false);
    this.connectors.set(key, input);
  }

  hasConnector(id: string, version: string): boolean {
    return this.connectors.has(connectorKey(id, version));
  }

  async registerConnection(input: SourceConnection): Promise<SourceConnection> {
    const connection = SourceConnectionSchema.parse(input);
    const connector = this.requireConnector(connection.connector_id, connection.connector_version);
    const unsupported = connection.delivery_kinds.filter(kind => !connector.manifest.delivery_kinds.includes(kind));
    if (unsupported.length > 0) {
      throw new CaptureRuntimeError(
        `Connection ${connection.id} requests unsupported delivery kinds: ${unsupported.join(", ")}`,
        "unsupported_delivery",
        "validation",
        false,
      );
    }
    await this.repository.registerCaptureConnection({ connection, manifest: connector.manifest, occurred_at: this.now() });
    return connection;
  }

  async submitBatch(input: unknown): Promise<CommitCaptureBatchResult> {
    const parsed = CaptureBatchSchema.safeParse(input);
    if (!parsed.success) throw new CaptureValidationError("invalid Capture Batch", parsed.error.issues);
    const batch = parsed.data;
    const connection = await this.requireConnection(batch.connection_id);
    this.assertBatchOwnership(connection, batch);
    const checkpoint = await this.nextCheckpoint(connection.id, batch);
    const normalized = batch.checkpoint
      ? batch
      : CaptureBatchSchema.parse({
          ...batch,
          checkpoint: {
            expected_revision: checkpoint.revision - 1,
            previous: (await this.repository.getCaptureCheckpoint(connection.id))?.cursor ?? {},
            next: checkpoint.cursor,
          },
        });

    let lastError: CaptureSafeError | undefined;
    for (let attempt = 1; attempt <= this.retryPolicy.max_attempts; attempt += 1) {
      let begun = false;
      try {
        await this.repository.beginCaptureAttempt({
          connection_id: connection.id,
          batch: normalized,
          attempt,
          max_in_flight: this.maxInFlight,
          occurred_at: this.now(),
        });
        begun = true;
        return await this.ingress.ingestBatch({ batch: normalized, connection, checkpoint, attempt });
      } catch (error) {
        const safe = safeCaptureError(error);
        lastError = safe;
        if (!begun) {
          await this.repository.appendCaptureTrace({
            connection_id: connection.id,
            batch_id: normalized.id,
            attempt,
            type: "capture.attempt_failed",
            occurred_at: this.now(),
            payload: { attempt_started: false },
            error: safe,
          });
          break;
        }
        const retry = attempt < this.retryPolicy.max_attempts && this.shouldRetry(safe);
        const deadLetter = retry ? undefined : CaptureDeadLetterSchema.parse({
          id: this.deadLetterId(normalized),
          connection_id: connection.id,
          batch: normalized,
          attempts: attempt,
          error: safe,
          status: "pending",
          created_at: this.now(),
        });
        await this.repository.failCaptureAttempt({
          connection_id: connection.id,
          batch: normalized,
          attempt,
          error: safe,
          occurred_at: this.now(),
          ...(deadLetter ? { dead_letter: deadLetter } : {}),
        });
        if (!retry) break;
        await this.repository.appendCaptureTrace({
          connection_id: connection.id,
          batch_id: normalized.id,
          attempt,
          type: "capture.retry_scheduled",
          occurred_at: this.now(),
          payload: { next_attempt: attempt + 1, retry_policy: { id: this.retryPolicy.id, revision: this.retryPolicy.revision } },
          error: safe,
        });
      }
    }
    const failure = lastError ?? CaptureSafeErrorSchema.parse({
      code: "capture_failed",
      message: "Capture failed without structured error evidence",
      stage: "runtime",
      retryable: false,
      details: {},
    });
    throw new CaptureRuntimeError(failure.message, failure.code, failure.stage, failure.retryable, failure.details);
  }

  async run(
    connectionId: string,
    delivery: Extract<CaptureDeliveryKind, "pull" | "stream" | "reference">,
    parameters: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<CommitCaptureBatchResult[]> {
    const connection = await this.requireConnection(connectionId);
    if (!connection.delivery_kinds.includes(delivery)) {
      throw new CaptureRuntimeError(`Connection ${connectionId} does not allow ${delivery}`, "unsupported_delivery", "validation", false);
    }
    const connector = this.requireConnector(connection.connector_id, connection.connector_version);
    await this.checkHealth(connection, connector, signal);
    const checkpoint = await this.currentCheckpoint(connection.id);
    const request: ConnectorOpenRequest = { delivery, checkpoint, parameters };
    const results: CommitCaptureBatchResult[] = [];
    try {
      for await (const batch of connector.open(connection, request, { signal })) {
        if (signal?.aborted) throw new CaptureRuntimeError("Connector operation was cancelled", "cancelled", "runtime", false);
        if (batch.delivery !== delivery) {
          throw new CaptureRuntimeError(`Connector emitted ${batch.delivery} during ${delivery}`, "connector_protocol_error", "connector", false);
        }
        results.push(await this.submitBatch(batch));
      }
      return results;
    } catch (error) {
      if (error instanceof CaptureRuntimeError) {
        if (error.stage === "connector") {
          await this.recordHealthFailure(connection.id, safeCaptureError(error, "connector"));
        }
        throw error;
      }
      if (error instanceof CaptureValidationError) {
        const safe = safeCaptureError(error, "connector");
        await this.recordHealthFailure(connection.id, safe);
        throw new CaptureRuntimeError(safe.message, safe.code, safe.stage, safe.retryable, safe.details, { cause: error });
      }
      const safe = safeCaptureError(error, "connector");
      await this.recordHealthFailure(connection.id, safe);
      throw new CaptureRuntimeError(safe.message, safe.code, safe.stage, safe.retryable, safe.details, { cause: error });
    }
  }

  async pause(connectionId: string): Promise<void> {
    await this.requireConnection(connectionId);
    await this.repository.setCapturePaused({ connection_id: connectionId, paused: true, occurred_at: this.now() });
  }

  async resume(connectionId: string): Promise<void> {
    await this.loadConnection(connectionId);
    await this.repository.setCapturePaused({ connection_id: connectionId, paused: false, occurred_at: this.now() });
  }

  async health(connectionId: string): Promise<ConnectorHealth> {
    const health = await this.repository.getCaptureHealth(connectionId);
    if (!health) throw new CaptureRuntimeError(`Capture connection ${connectionId} has no health state`, "connection_not_found", "runtime", false);
    return health;
  }

  async check(connectionId: string, signal?: AbortSignal): Promise<ConnectorHealth> {
    const connection = await this.repository.getCaptureConnection(connectionId);
    if (!connection) throw new CaptureRuntimeError(`Capture connection ${connectionId} does not exist`, "connection_not_found", "runtime", false);
    const connector = this.requireConnector(connection.connector_id, connection.connector_version);
    await this.checkHealth(connection, connector, signal);
    return (await this.repository.getCaptureHealth(connectionId))!;
  }

  async replayDeadLetter(id: string): Promise<CommitCaptureBatchResult> {
    const deadLetter = await this.repository.getCaptureDeadLetter(id);
    if (!deadLetter) throw new CaptureRuntimeError(`Dead letter ${id} does not exist`, "dead_letter_not_found", "runtime", false);
    if (deadLetter.status !== "pending") throw new CaptureRuntimeError(`Dead letter ${id} is already resolved`, "dead_letter_resolved", "runtime", false);
    await this.repository.appendCaptureTrace({
      connection_id: deadLetter.connection_id,
      batch_id: deadLetter.batch.id,
      type: "capture.dead_letter_replayed",
      occurred_at: this.now(),
      payload: { dead_letter_id: deadLetter.id },
    });
    const result = await this.submitBatch(deadLetter.batch);
    await this.repository.resolveCaptureDeadLetter({ id, resolved_at: this.now() });
    return result;
  }

  private async checkHealth(connection: SourceConnection, connector: ConnectorPort, signal?: AbortSignal): Promise<void> {
    try {
      const result = await connector.health(connection, { signal });
      const health = ConnectorHealthSchema.parse({
        connection_id: connection.id,
        status: "healthy",
        observed_at: this.now(),
        consecutive_failures: 0,
        capabilities: result.capabilities,
        last_success_at: this.now(),
      });
      await this.repository.recordCaptureHealth({
        health,
        event: {
          connection_id: connection.id,
          type: "connector.health_checked",
          occurred_at: this.now(),
          payload: { status: health.status, capabilities: health.capabilities },
        },
      });
    } catch (error) {
      const safe = safeCaptureError(error, "connector");
      await this.recordHealthFailure(connection.id, safe);
      throw new CaptureRuntimeError(safe.message, safe.code, safe.stage, safe.retryable, safe.details, { cause: error });
    }
  }

  private async recordHealthFailure(connectionId: string, error: CaptureSafeError): Promise<void> {
    const current = await this.repository.getCaptureHealth(connectionId);
    const failures = (current?.consecutive_failures ?? 0) + 1;
    const health = ConnectorHealthSchema.parse({
      connection_id: connectionId,
      status: failures >= this.retryPolicy.max_attempts ? "unhealthy" : "degraded",
      observed_at: this.now(),
      consecutive_failures: failures,
      capabilities: current?.capabilities ?? [],
      ...(current?.last_success_at ? { last_success_at: current.last_success_at } : {}),
      last_error: error,
    });
    await this.repository.recordCaptureHealth({
      health,
      event: {
        connection_id: connectionId,
        type: "connector.health_checked",
        occurred_at: this.now(),
        payload: { status: health.status },
        error,
      },
    });
  }

  private async requireConnection(id: string): Promise<SourceConnection> {
    const connection = await this.loadConnection(id);
    if ((await this.repository.getCaptureHealth(id))?.status === "paused") {
      throw new CaptureRuntimeError(`Capture connection ${id} is paused`, "connection_paused", "runtime", false);
    }
    return connection;
  }

  private async loadConnection(id: string): Promise<SourceConnection> {
    const connection = await this.repository.getCaptureConnection(id);
    if (!connection) throw new CaptureRuntimeError(`Capture connection ${id} does not exist`, "connection_not_found", "runtime", false);
    if (!connection.enabled) throw new CaptureRuntimeError(`Capture connection ${id} is disabled`, "connection_disabled", "runtime", false);
    return connection;
  }

  private requireConnector(id: string, version: string): ConnectorPort {
    const connector = this.connectors.get(connectorKey(id, version));
    if (!connector) throw new CaptureRuntimeError(`Connector ${id}@${version} is not registered`, "connector_not_found", "runtime", false);
    return connector;
  }

  private assertBatchOwnership(connection: SourceConnection, batch: CaptureBatch): void {
    if (batch.connector.id !== connection.connector_id || batch.connector.version !== connection.connector_version) {
      throw new CaptureRuntimeError(`Capture Batch ${batch.id} does not match connection ${connection.id}`, "connector_mismatch", "validation", false);
    }
    if (!connection.delivery_kinds.includes(batch.delivery)) {
      throw new CaptureRuntimeError(`Connection ${connection.id} does not permit ${batch.delivery}`, "unsupported_delivery", "validation", false);
    }
  }

  private async currentCheckpoint(connectionId: string) {
    return (await this.repository.getCaptureCheckpoint(connectionId)) ?? CaptureCheckpointSchema.parse({
      connection_id: connectionId,
      revision: 0,
      cursor: {},
      updated_at: this.now(),
    });
  }

  private async nextCheckpoint(connectionId: string, batch: CaptureBatch) {
    const current = await this.currentCheckpoint(connectionId);
    if (batch.checkpoint) {
      return CaptureCheckpointSchema.parse({
        connection_id: connectionId,
        revision: batch.checkpoint.expected_revision + 1,
        cursor: batch.checkpoint.next,
        updated_at: this.now(),
      });
    }
    return CaptureCheckpointSchema.parse({
      connection_id: connectionId,
      revision: current.revision + 1,
      cursor: { last_batch_id: batch.id, sequence: batch.sequence },
      updated_at: this.now(),
    });
  }

  private shouldRetry(error: CaptureSafeError): boolean {
    if (this.retryPolicy.non_retryable_codes.includes(error.code)) return false;
    if (this.retryPolicy.retryable_codes.length > 0) return this.retryPolicy.retryable_codes.includes(error.code);
    return error.retryable;
  }
}

function connectorKey(id: string, version: string): string {
  return `${id}@${version}`;
}
