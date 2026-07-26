import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  AutomationDeliveryLedger,
  AutomationDeliveryLedgerEntry,
  AutomationTraceRecord,
  AutomationTraceStore,
  AutomationOccurrenceRepository,
  OccurrenceReservation,
  ReactiveCascadeAttemptRecord,
  ReactiveCascadeLedger,
  ReactiveCascadePlanReservation,
  ReactiveCascadeEvent,
  TriggerOccurrence,
} from "@info/automation";
import {
  AutomationDeliveryRequestSchema,
  AutomationDeliveryResultSchema,
  AutomationTraceEventSchema,
  ReactiveCascadeLimitError,
} from "@info/automation";
import {
  ReactiveCascadeContextSchema,
  canonicalJson,
  type ReactiveCascadeContext,
} from "@info/view";

type OccurrenceStatus = "reserved" | "succeeded" | "failed";

type OccurrenceRow = {
  idempotency_key: string;
  correlation_id: string;
  automation_view_id: string;
  automation_revision: number;
  trigger_id: string;
  status: OccurrenceStatus;
  run_id: string | null;
  error: string | null;
  reserved_at: string;
  updated_at: string;
  occurrence_json: string;
  attempt_id: string | null;
  request_fingerprint: string | null;
  lease_expires_at: string | null;
};

type DeliveryLedgerRow = {
  request_id: string;
  delivery_id: string | null;
  request_json: string;
  result_json: string;
  recorded_at: string;
};

type AutomationTraceRow = {
  sequence: number;
  correlation_id: string;
  occurred_at: string;
  recorded_at: string;
  event_json: string;
};

export class AutomationOccurrenceRepositoryError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "corrupt_data" | "storage_failure",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationOccurrenceRepositoryError";
  }
}

export class SqliteAutomationOccurrenceRepository implements AutomationOccurrenceRepository {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  async reserve(input: {
    idempotency_key: string;
    correlation_id: string;
    occurrence: TriggerOccurrence;
    reserved_at: string;
    attempt_id?: string;
    lease_duration_ms?: number;
    limits: { cooldown_ms: number; max_concurrency: number };
  }): Promise<OccurrenceReservation> {
    const reservedAtMs = Date.parse(input.reserved_at);
    if (!Number.isFinite(reservedAtMs)) {
      throw new AutomationOccurrenceRepositoryError("reserved_at must be a valid timestamp", "corrupt_data");
    }
    const attemptId = input.attempt_id ?? `${input.correlation_id}:attempt:0`;
    const leaseDurationMs = input.lease_duration_ms ?? 300_000;
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1) {
      throw new AutomationOccurrenceRepositoryError("lease_duration_ms must be a positive integer", "corrupt_data");
    }
    const requestFingerprint = createHash("sha256").update(canonicalJson({
      occurrence: input.occurrence,
      attempt_id: attemptId,
    })).digest("hex");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.getRow(input.idempotency_key);
      if (duplicate) {
        const storedFingerprint = duplicate.request_fingerprint ?? createHash("sha256").update(canonicalJson({
          occurrence: JSON.parse(duplicate.occurrence_json),
          attempt_id: duplicate.attempt_id ?? `${duplicate.correlation_id}:attempt:0`,
        })).digest("hex");
        if (storedFingerprint !== requestFingerprint) {
          throw new AutomationOccurrenceRepositoryError(
            `Automation occurrence key was reused with different evidence: ${input.idempotency_key}`,
            "conflict",
          );
        }
        if (
          duplicate.status === "reserved"
          && duplicate.lease_expires_at
          && Date.parse(duplicate.lease_expires_at) <= reservedAtMs
        ) {
          const leaseExpiresAt = new Date(reservedAtMs + leaseDurationMs).toISOString();
          this.db.prepare(`
            update automation_occurrences_v1
            set reserved_at = ?, updated_at = ?, lease_expires_at = ?,
                attempt_id = ?, request_fingerprint = ?
            where idempotency_key = ? and status = 'reserved'
          `).run(input.reserved_at, input.reserved_at, leaseExpiresAt, attemptId, requestFingerprint, input.idempotency_key);
          this.db.exec("COMMIT");
          return { created: true, recovered: true };
        }
        this.db.exec("COMMIT");
        return reservationRejection("duplicate", duplicate);
      }

      const identity = [
        input.occurrence.automation.view_id,
        input.occurrence.automation.revision,
        input.occurrence.trigger_id,
      ] as const;

      if (input.limits.cooldown_ms > 0) {
        const cutoff = new Date(reservedAtMs - input.limits.cooldown_ms).toISOString();
        const cooling = this.db.prepare(`
          select * from automation_occurrences_v1
          where automation_view_id = ? and automation_revision = ? and trigger_id = ?
            and reserved_at >= ?
          order by reserved_at desc
          limit 1
        `).get(...identity, cutoff) as OccurrenceRow | undefined;
        if (cooling) {
          this.db.exec("COMMIT");
          return reservationRejection("cooldown", cooling);
        }
      }

      const active = this.db.prepare(`
        select * from automation_occurrences_v1
        where automation_view_id = ? and automation_revision = ? and trigger_id = ?
          and status = 'reserved' and (lease_expires_at is null or lease_expires_at > ?)
        order by reserved_at desc
      `).all(...identity, input.reserved_at) as OccurrenceRow[];
      if (active.length >= input.limits.max_concurrency) {
        this.db.exec("COMMIT");
        return reservationRejection("concurrency", active[0]);
      }

      this.db.prepare(`
        insert into automation_occurrences_v1 (
          idempotency_key, correlation_id, automation_view_id,
          automation_revision, trigger_id, status, run_id, error,
          reserved_at, updated_at, occurrence_json, attempt_id,
          request_fingerprint, lease_expires_at
        ) values (?, ?, ?, ?, ?, 'reserved', null, null, ?, ?, ?, ?, ?, ?)
      `).run(
        input.idempotency_key,
        input.correlation_id,
        input.occurrence.automation.view_id,
        input.occurrence.automation.revision,
        input.occurrence.trigger_id,
        input.reserved_at,
        input.reserved_at,
        JSON.stringify(input.occurrence),
        attemptId,
        requestFingerprint,
        new Date(reservedAtMs + leaseDurationMs).toISOString(),
      );
      this.db.exec("COMMIT");
      return { created: true };
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationOccurrenceRepositoryError) throw error;
      throw new AutomationOccurrenceRepositoryError("failed to reserve Automation occurrence", "storage_failure", { cause: error });
    }
  }

  async finalize(input: {
    idempotency_key: string;
    correlation_id: string;
    status: "succeeded" | "failed";
    run_id?: string;
    error?: string;
  }): Promise<void> {
    const updatedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRow(input.idempotency_key);
      if (!current) {
        throw new AutomationOccurrenceRepositoryError(
          `Automation occurrence is missing: ${input.idempotency_key}`,
          "corrupt_data",
        );
      }
      if (current.correlation_id !== input.correlation_id) {
        throw new AutomationOccurrenceRepositoryError(
          `Automation occurrence correlation conflict for ${input.idempotency_key}`,
          "conflict",
        );
      }
      if (current.status !== "reserved") {
        const sameFinalState = current.status === input.status
          && (current.run_id ?? undefined) === input.run_id
          && (current.error ?? undefined) === input.error;
        if (!sameFinalState) {
          throw new AutomationOccurrenceRepositoryError(
            `Automation occurrence is already ${current.status}: ${input.idempotency_key}`,
            "conflict",
          );
        }
        this.db.exec("COMMIT");
        return;
      }
      this.db.prepare(`
        update automation_occurrences_v1
        set status = ?, run_id = ?, error = ?, updated_at = ?, lease_expires_at = null
        where idempotency_key = ?
      `).run(
        input.status,
        input.run_id ?? null,
        input.error ?? null,
        updatedAt,
        input.idempotency_key,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationOccurrenceRepositoryError) throw error;
      throw new AutomationOccurrenceRepositoryError("failed to finalize Automation occurrence", "storage_failure", { cause: error });
    }
  }

  inspect(idempotencyKey: string): {
    correlation_id: string;
    status: OccurrenceStatus;
    run_id?: string;
    error?: string;
    occurrence: TriggerOccurrence;
  } | undefined {
    const row = this.getRow(idempotencyKey);
    if (!row) return undefined;
    let occurrence: TriggerOccurrence;
    try {
      occurrence = JSON.parse(row.occurrence_json) as TriggerOccurrence;
    } catch (error) {
      throw new AutomationOccurrenceRepositoryError("stored Automation occurrence is invalid JSON", "corrupt_data", { cause: error });
    }
    return {
      correlation_id: row.correlation_id,
      status: row.status,
      run_id: row.run_id ?? undefined,
      error: row.error ?? undefined,
      occurrence,
    };
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private getRow(idempotencyKey: string): OccurrenceRow | undefined {
    return this.db.prepare(`
      select * from automation_occurrences_v1 where idempotency_key = ?
    `).get(idempotencyKey) as OccurrenceRow | undefined;
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists automation_occurrences_v1 (
        idempotency_key text primary key,
        correlation_id text not null unique,
        automation_view_id text not null,
        automation_revision integer not null,
        trigger_id text not null,
        status text not null check(status in ('reserved', 'succeeded', 'failed')),
        run_id text,
        error text,
        reserved_at text not null,
        updated_at text not null,
        occurrence_json text not null
      );

      create index if not exists idx_automation_occurrences_v1_identity
        on automation_occurrences_v1(automation_view_id, automation_revision, trigger_id, reserved_at desc);
      create index if not exists idx_automation_occurrences_v1_active
        on automation_occurrences_v1(automation_view_id, automation_revision, trigger_id, status);
    `);
    this.ensureColumn("automation_occurrences_v1", "attempt_id", "text");
    this.ensureColumn("automation_occurrences_v1", "request_fingerprint", "text");
    this.ensureColumn("automation_occurrences_v1", "lease_expires_at", "text");
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some(item => item.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${declaration}`);
    }
  }
}

type CascadeAttemptRow = {
  attempt_id: string;
  root_correlation_id: string;
  root_event_id: string;
  parent_event_id: string;
  automation_view_id: string;
  automation_revision: number;
  transformation_id: string;
  transformation_revision: number;
  operator_id: string | null;
  operator_revision: number | null;
  status: ReactiveCascadeAttemptRecord["status"];
  request_fingerprint: string;
  reserved_at: string;
  lease_expires_at: string | null;
  updated_at: string;
  run_id: string | null;
  error_code: string | null;
  error_message: string | null;
  cost_usd: number;
  context_json: string;
};

export class SqliteReactiveCascadeLedger implements ReactiveCascadeLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  async reservePlan(input: {
    attempts: ReactiveCascadeContext[];
    reserved_at: string;
  }): Promise<ReactiveCascadePlanReservation> {
    const reservedAt = Date.parse(input.reserved_at);
    if (!Number.isFinite(reservedAt) || input.attempts.length === 0) {
      throw new AutomationOccurrenceRepositoryError("cascade reservation requires attempts and a valid timestamp", "corrupt_data");
    }
    let attempts = input.attempts.map(value => ReactiveCascadeContextSchema.parse(value));
    const requestFingerprints = new Map(attempts.map(attempt => [attempt.attempt_id, cascadeFingerprint(attempt)]));
    assertAtomicCascadePlan(attempts);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = attempts.map(attempt => this.getRow(attempt.attempt_id));
      if (existing.some(Boolean)) {
        if (!existing.every(Boolean)) {
          throw new AutomationOccurrenceRepositoryError("cascade plan is partially reserved", "corrupt_data");
        }
        const records = existing.map((row, index) => {
          const record = this.parseRow(row!);
          const requested = requestFingerprints.get(attempts[index]!.attempt_id)!;
          if (record.request_fingerprint !== requested) {
            throw new AutomationOccurrenceRepositoryError(
              `cascade attempt id was reused with different evidence: ${attempts[index]!.attempt_id}`,
              "conflict",
            );
          }
          return record;
        });
        const recoverable = records.filter(record => (
          (record.status === "reserved" || record.status === "running")
          && record.lease_expires_at !== undefined
          && Date.parse(record.lease_expires_at) <= reservedAt
        ));
        if (recoverable.length > 0) {
          for (const record of recoverable) {
            const leaseExpiresAt = new Date(reservedAt + record.context.policy.limits.reservation_lease_ms).toISOString();
            const nextStatus = "reserved";
            this.db.prepare(`
              update reactive_cascade_attempts_v1
              set status = ?, reserved_at = ?, lease_expires_at = ?, updated_at = ?
              where attempt_id = ? and status = ?
            `).run(nextStatus, input.reserved_at, leaseExpiresAt, input.reserved_at, record.context.attempt_id, record.status);
            this.insertCascadeEvent(record.context, "recovered", input.reserved_at, {
              previous_status: record.status,
              status: nextStatus,
              lease_expires_at: leaseExpiresAt,
            });
          }
          const recovered = attempts.map(attempt => this.mustRecord(attempt.attempt_id));
          this.db.exec("COMMIT");
          return { outcome: "recovered", attempts: recovered };
        }
        for (const record of records) {
          this.insertCascadeEvent(record.context, "duplicate", input.reserved_at, { status: record.status });
        }
        this.db.exec("COMMIT");
        return { outcome: "duplicate", attempts: records };
      }

      const rootRows = this.db.prepare(`
        select * from reactive_cascade_attempts_v1 where root_correlation_id = ?
      `).all(attempts[0]!.root_correlation_id) as CascadeAttemptRow[];
      for (const row of rootRows) {
        const prior = this.parseRow(row).context;
        if (
          prior.root_event_id !== attempts[0]!.root_event_id
          || canonicalJson(prior.policy) !== canonicalJson(attempts[0]!.policy)
        ) {
          throw new AutomationOccurrenceRepositoryError(
            `cascade root policy or root event changed: ${attempts[0]!.root_correlation_id}`,
            "conflict",
          );
        }
      }
      for (const attempt of attempts) {
        const parent = attempt.parent_attempt_id ? this.getRow(attempt.parent_attempt_id) : undefined;
        if (attempt.parent_attempt_id && (!parent || parent.root_correlation_id !== attempt.root_correlation_id)) {
          throw new AutomationOccurrenceRepositoryError(
            `cascade parent attempt is missing from root ${attempt.root_correlation_id}: ${attempt.parent_attempt_id}`,
            "conflict",
          );
        }
        if (attempt.replay) {
          if (
            !parent
            || attempt.replay.previous_cascade_attempt_id !== attempt.parent_attempt_id
            || !["succeeded", "failed", "stopped"].includes(parent.status)
          ) {
            throw new AutomationOccurrenceRepositoryError(
              `cascade replay does not link a terminal parent attempt: ${attempt.attempt_id}`,
              "conflict",
            );
          }
        }
      }
      const priorCost = rootRows.reduce((total, row) => total + row.cost_usd, 0);
      const aggregateAttempts = rootRows.length + attempts.length;
      attempts = attempts.map(attempt => ReactiveCascadeContextSchema.parse({
        ...attempt,
        aggregate: { attempts: aggregateAttempts, cost_usd: priorCost },
      }));
      const stop = cascadeStop(attempts, reservedAt);
      if (stop) {
        attempts = attempts.map(attempt => ReactiveCascadeContextSchema.parse({
          ...attempt,
          disposition: "terminal",
          terminal: { code: stop.code, message: stop.message, stage: "admission" },
        }));
      }
      const status = stop ? "stopped" : "reserved";
      for (const attempt of attempts) {
        const leaseExpiresAt = stop
          ? null
          : new Date(reservedAt + attempt.policy.limits.reservation_lease_ms).toISOString();
        this.insert({
          context: attempt,
          status,
          request_fingerprint: requestFingerprints.get(attempt.attempt_id)!,
          reserved_at: input.reserved_at,
          lease_expires_at: leaseExpiresAt ?? undefined,
          updated_at: input.reserved_at,
          error_code: stop?.code,
          error_message: stop?.message,
          cost_usd: 0,
        });
        this.insertCascadeEvent(attempt, stop ? "stopped" : "reserved", input.reserved_at, stop
          ? { code: stop.code, message: stop.message }
          : { lease_expires_at: leaseExpiresAt });
      }
      const records = attempts.map(attempt => this.mustRecord(attempt.attempt_id));
      this.db.exec("COMMIT");
      return stop
        ? { outcome: "stopped", code: stop.code, message: stop.message, attempts: records }
        : { outcome: "created", attempts: records };
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationOccurrenceRepositoryError) throw error;
      throw new AutomationOccurrenceRepositoryError("failed to reserve reactive cascade plan", "storage_failure", { cause: error });
    }
  }

  async bindOperator(input: {
    attempt_id: string;
    operator: { id: string; revision: number };
    run_id: string;
    started_at: string;
  }): Promise<ReactiveCascadeAttemptRecord> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.mustRecord(input.attempt_id);
      if (current.status === "succeeded" || current.status === "failed") {
        const same = current.run_id === input.run_id
          && current.context.target.operator?.id === input.operator.id
          && current.context.target.operator?.revision === input.operator.revision;
        if (!same) {
          throw new AutomationOccurrenceRepositoryError(
            `terminal cascade attempt replay changed Operator or Run: ${input.attempt_id}`,
            "conflict",
          );
        }
        this.insertCascadeEvent(current.context, "duplicate", input.started_at, {
          status: current.status,
          run_id: input.run_id,
        });
        this.db.exec("COMMIT");
        return current;
      }
      if (current.status === "running") {
        const same = current.run_id === input.run_id
          && current.context.target.operator?.id === input.operator.id
          && current.context.target.operator?.revision === input.operator.revision;
        if (!same) throw new AutomationOccurrenceRepositoryError(`cascade attempt is already running: ${input.attempt_id}`, "conflict");
        this.db.exec("COMMIT");
        return current;
      }
      if (current.status !== "reserved") {
        throw new AutomationOccurrenceRepositoryError(`cascade attempt cannot start from ${current.status}: ${input.attempt_id}`, "conflict");
      }
      if (current.run_id || current.context.target.operator) {
        const same = current.run_id === input.run_id
          && current.context.target.operator?.id === input.operator.id
          && current.context.target.operator?.revision === input.operator.revision;
        if (!same) {
          throw new AutomationOccurrenceRepositoryError(
            `cascade recovery changed Operator or Run: ${input.attempt_id}`,
            "conflict",
          );
        }
        this.db.exec("COMMIT");
        return current;
      }
      const operatorKey = `${input.operator.id}@${input.operator.revision}`;
      const active = this.db.prepare(`
        select count(*) as count from reactive_cascade_attempts_v1
        where operator_id = ? and operator_revision = ? and status = 'running'
      `).get(input.operator.id, input.operator.revision) as { count: number };
      if (active.count >= current.context.policy.limits.max_operator_concurrency) {
        throw new ReactiveCascadeLimitError(
          `cascade Operator concurrency exhausted for ${operatorKey}`,
          "operator_concurrency_exhausted",
          input.attempt_id,
        );
      }
      const context = ReactiveCascadeContextSchema.parse({
        ...current.context,
        target: { ...current.context.target, operator: input.operator },
      });
      this.db.prepare(`
        update reactive_cascade_attempts_v1
        set operator_id = ?, operator_revision = ?, status = 'running', run_id = ?,
            lease_expires_at = ?, updated_at = ?, context_json = ?
        where attempt_id = ? and status = 'reserved'
      `).run(
        input.operator.id,
        input.operator.revision,
        input.run_id,
        new Date(Date.parse(input.started_at) + context.policy.limits.reservation_lease_ms).toISOString(),
        input.started_at,
        JSON.stringify(context),
        input.attempt_id,
      );
      const result = this.mustRecord(input.attempt_id);
      this.insertCascadeEvent(result.context, "operator_bound", input.started_at, {
        operator: input.operator,
        run_id: input.run_id,
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationOccurrenceRepositoryError || error instanceof ReactiveCascadeLimitError) throw error;
      throw new AutomationOccurrenceRepositoryError("failed to bind cascade Operator", "storage_failure", { cause: error });
    }
  }

  async finalize(input: {
    attempt_id: string;
    status: "succeeded" | "failed" | "stopped";
    completed_at: string;
    run_id?: string;
    cost_usd: number;
    error_code?: string;
    error_message?: string;
  }): Promise<ReactiveCascadeAttemptRecord> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.mustRecord(input.attempt_id);
      if (current.status === input.status) {
        const same = current.run_id === input.run_id
          && current.cost_usd === input.cost_usd
          && current.error_code === input.error_code
          && current.error_message === input.error_message;
        if (!same) throw new AutomationOccurrenceRepositoryError(`cascade terminal replay conflict: ${input.attempt_id}`, "conflict");
        this.db.exec("COMMIT");
        return current;
      }
      if (
        current.status !== "running"
        && !(current.status === "reserved" && (input.status === "stopped" || input.run_id !== undefined))
      ) {
        throw new AutomationOccurrenceRepositoryError(`cascade attempt cannot finalize from ${current.status}: ${input.attempt_id}`, "conflict");
      }
      if (input.run_id && current.run_id && input.run_id !== current.run_id) {
        throw new AutomationOccurrenceRepositoryError(`cascade Run conflict: ${input.attempt_id}`, "conflict");
      }
      this.db.prepare(`
        update reactive_cascade_attempts_v1
        set status = ?, run_id = ?, error_code = ?, error_message = ?, cost_usd = ?,
            lease_expires_at = null, updated_at = ?
        where attempt_id = ?
      `).run(
        input.status,
        input.run_id ?? current.run_id ?? null,
        input.error_code ?? null,
        input.error_message ?? null,
        input.cost_usd,
        input.completed_at,
        input.attempt_id,
      );
      const result = this.mustRecord(input.attempt_id);
      this.insertCascadeEvent(result.context, input.status, input.completed_at, {
        ...(input.run_id ? { run_id: input.run_id } : {}),
        cost_usd: input.cost_usd,
        ...(input.error_code ? { error_code: input.error_code } : {}),
        ...(input.error_message ? { error_message: input.error_message } : {}),
      });
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationOccurrenceRepositoryError) throw error;
      throw new AutomationOccurrenceRepositoryError("failed to finalize reactive cascade attempt", "storage_failure", { cause: error });
    }
  }

  async getAttempt(attemptId: string): Promise<ReactiveCascadeAttemptRecord | undefined> {
    const row = this.getRow(attemptId);
    return row ? this.parseRow(row) : undefined;
  }

  async listRoot(rootCorrelationId: string): Promise<ReactiveCascadeAttemptRecord[]> {
    const rows = this.db.prepare(`
      select * from reactive_cascade_attempts_v1
      where root_correlation_id = ? order by reserved_at, attempt_id
    `).all(rootCorrelationId) as CascadeAttemptRow[];
    return rows.map(row => this.parseRow(row));
  }

  async listEvents(rootCorrelationId: string): Promise<ReactiveCascadeEvent[]> {
    const rows = this.db.prepare(`
      select sequence, attempt_id, root_correlation_id, type, occurred_at, payload_json
      from reactive_cascade_events_v1
      where root_correlation_id = ? order by sequence
    `).all(rootCorrelationId) as Array<{
      sequence: number;
      attempt_id: string;
      root_correlation_id: string;
      type: ReactiveCascadeEvent["type"];
      occurred_at: string;
      payload_json: string;
    }>;
    return rows.map(row => ({
      sequence: row.sequence,
      attempt_id: row.attempt_id,
      root_correlation_id: row.root_correlation_id,
      type: row.type,
      occurred_at: row.occurred_at,
      payload: JSON.parse(row.payload_json) as ReactiveCascadeEvent["payload"],
    }));
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private getRow(attemptId: string): CascadeAttemptRow | undefined {
    return this.db.prepare(`select * from reactive_cascade_attempts_v1 where attempt_id = ?`).get(attemptId) as CascadeAttemptRow | undefined;
  }

  private mustRecord(attemptId: string): ReactiveCascadeAttemptRecord {
    const row = this.getRow(attemptId);
    if (!row) throw new AutomationOccurrenceRepositoryError(`cascade attempt is missing: ${attemptId}`, "corrupt_data");
    return this.parseRow(row);
  }

  private parseRow(row: CascadeAttemptRow): ReactiveCascadeAttemptRecord {
    let context: ReactiveCascadeContext;
    try {
      context = ReactiveCascadeContextSchema.parse(JSON.parse(row.context_json));
    } catch (error) {
      throw new AutomationOccurrenceRepositoryError(`stored cascade attempt is corrupt: ${row.attempt_id}`, "corrupt_data", { cause: error });
    }
    return {
      context,
      status: row.status,
      request_fingerprint: row.request_fingerprint,
      reserved_at: row.reserved_at,
      ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
      updated_at: row.updated_at,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      ...(row.error_code ? { error_code: row.error_code } : {}),
      ...(row.error_message ? { error_message: row.error_message } : {}),
      cost_usd: row.cost_usd,
    };
  }

  private insert(record: ReactiveCascadeAttemptRecord): void {
    const context = record.context;
    this.db.prepare(`
      insert into reactive_cascade_attempts_v1 (
        attempt_id, root_correlation_id, root_event_id, parent_event_id,
        automation_view_id, automation_revision, transformation_id, transformation_revision,
        operator_id, operator_revision, status, request_fingerprint, reserved_at,
        lease_expires_at, updated_at, run_id, error_code, error_message, cost_usd, context_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      context.attempt_id,
      context.root_correlation_id,
      context.root_event_id,
      context.parent_event_id,
      context.target.automation.view_id,
      context.target.automation.revision,
      context.target.transformation.transformation_id,
      context.target.transformation.revision,
      context.target.operator?.id ?? null,
      context.target.operator?.revision ?? null,
      record.status,
      record.request_fingerprint,
      record.reserved_at,
      record.lease_expires_at ?? null,
      record.updated_at,
      record.run_id ?? null,
      record.error_code ?? null,
      record.error_message ?? null,
      record.cost_usd,
      JSON.stringify(context),
    );
  }

  private insertCascadeEvent(
    context: ReactiveCascadeContext,
    type: ReactiveCascadeEvent["type"],
    occurredAt: string,
    payload: ReactiveCascadeEvent["payload"],
  ): void {
    this.db.prepare(`
      insert into reactive_cascade_events_v1 (
        attempt_id, root_correlation_id, type, occurred_at, payload_json
      ) values (?, ?, ?, ?, ?)
    `).run(context.attempt_id, context.root_correlation_id, type, occurredAt, JSON.stringify(payload));
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists reactive_cascade_attempts_v1 (
        attempt_id text primary key,
        root_correlation_id text not null,
        root_event_id text not null,
        parent_event_id text not null,
        automation_view_id text not null,
        automation_revision integer not null,
        transformation_id text not null,
        transformation_revision integer not null,
        operator_id text,
        operator_revision integer,
        status text not null check(status in ('reserved', 'running', 'succeeded', 'failed', 'stopped')),
        request_fingerprint text not null,
        reserved_at text not null,
        lease_expires_at text,
        updated_at text not null,
        run_id text,
        error_code text,
        error_message text,
        cost_usd real not null,
        context_json text not null
      );
      create index if not exists idx_reactive_cascade_root_v1
        on reactive_cascade_attempts_v1(root_correlation_id, reserved_at, attempt_id);
      create index if not exists idx_reactive_cascade_operator_v1
        on reactive_cascade_attempts_v1(operator_id, operator_revision, status);
      create table if not exists reactive_cascade_events_v1 (
        sequence integer primary key autoincrement,
        attempt_id text not null,
        root_correlation_id text not null,
        type text not null check(type in ('reserved', 'recovered', 'duplicate', 'operator_bound', 'succeeded', 'failed', 'stopped')),
        occurred_at text not null,
        payload_json text not null
      );
      create index if not exists idx_reactive_cascade_events_root_v1
        on reactive_cascade_events_v1(root_correlation_id, sequence);
    `);
  }
}

function assertAtomicCascadePlan(attempts: ReactiveCascadeContext[]): void {
  const first = attempts[0]!;
  const root = first.root_correlation_id;
  const rootEvent = first.root_event_id;
  const rootStartedAt = first.root_started_at;
  const parentEvent = first.parent_event_id;
  const policy = canonicalJson(first.policy);
  if (attempts.some(attempt => (
    attempt.root_correlation_id !== root
    || attempt.root_event_id !== rootEvent
    || attempt.root_started_at !== rootStartedAt
    || attempt.parent_event_id !== parentEvent
    || canonicalJson(attempt.policy) !== policy
    || attempt.fan_out_total !== attempts.length
  ))) {
    throw new AutomationOccurrenceRepositoryError("cascade fan-out plan must freeze one root, event, policy, and total", "conflict");
  }
  const indexes = attempts.map(attempt => attempt.fan_out_index).sort((left, right) => left - right);
  if (indexes.some((value, index) => value !== index)) {
    throw new AutomationOccurrenceRepositoryError("cascade fan-out indexes must be contiguous", "conflict");
  }
}

function cascadeStop(
  attempts: ReactiveCascadeContext[],
  reservedAt: number,
): { code: Extract<ReactiveCascadePlanReservation, { outcome: "stopped" }>["code"]; message: string } | undefined {
  const first = attempts[0]!;
  const limits = first.policy.limits;
  if (attempts.some(attempt => attempt.depth > limits.max_depth)) {
    return { code: "depth_exhausted", message: `cascade depth exceeds ${limits.max_depth}` };
  }
  if (attempts.length > limits.max_fan_out) {
    return { code: "fan_out_exhausted", message: `cascade fan-out ${attempts.length} exceeds ${limits.max_fan_out}` };
  }
  if (first.aggregate.attempts > limits.max_total_attempts) {
    return { code: "attempts_exhausted", message: `cascade attempts ${first.aggregate.attempts} exceed ${limits.max_total_attempts}` };
  }
  if (first.aggregate.cost_usd > limits.max_total_cost_usd) {
    return { code: "cost_exhausted", message: `cascade cost ${first.aggregate.cost_usd} exceeds ${limits.max_total_cost_usd}` };
  }
  if (reservedAt - Date.parse(first.root_started_at) > limits.max_elapsed_ms) {
    return { code: "time_exhausted", message: `cascade elapsed time exceeds ${limits.max_elapsed_ms}ms` };
  }
  if (attempts.some(attempt => {
    if (attempt.replay) return false;
    const latest = attempt.semantic_fingerprints.at(-1);
    return latest !== undefined && attempt.semantic_fingerprints.slice(0, -1).includes(latest);
  })) {
    return { code: "cycle", message: "cascade semantic transition repeated in the same root" };
  }
  return undefined;
}

function cascadeFingerprint(context: ReactiveCascadeContext): string {
  return createHash("sha256").update(canonicalJson(context)).digest("hex");
}

export class AutomationDeliveryLedgerError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "corrupt_data" | "storage_failure",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationDeliveryLedgerError";
  }
}

export class SqliteAutomationDeliveryLedger implements AutomationDeliveryLedger {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  async record(entry: AutomationDeliveryLedgerEntry): Promise<void> {
    const request = AutomationDeliveryRequestSchema.safeParse(entry.request);
    const result = AutomationDeliveryResultSchema.safeParse(entry.result);
    if (!request.success || !result.success || !Number.isFinite(Date.parse(entry.recorded_at))) {
      throw new AutomationDeliveryLedgerError("Delivery ledger entry is invalid", "corrupt_data", {
        cause: !request.success ? request.error : !result.success ? result.error : undefined,
      });
    }
    const normalized = { request: request.data, result: result.data };
    const deliveryId = result.data.status === "delivered" ? result.data.delivery_id : null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getByRequestId(request.data.id);
      if (existing) {
        const parsed = this.parseRow(existing);
        if (!sameDeliveryEntry(parsed, normalized)) {
          throw new AutomationDeliveryLedgerError(`Delivery request id conflict: ${request.data.id}`, "conflict");
        }
        this.db.exec("COMMIT");
        return;
      }
      if (deliveryId) {
        const owner = this.getByDeliveryId(deliveryId);
        if (owner && owner.request_id !== request.data.id) {
          throw new AutomationDeliveryLedgerError(`Delivery id conflict: ${deliveryId}`, "conflict");
        }
      }
      this.db.prepare(`
        insert into automation_delivery_ledger_v1 (
          request_id, delivery_id, request_json, result_json, recorded_at
        ) values (?, ?, ?, ?, ?)
      `).run(
        request.data.id,
        deliveryId,
        JSON.stringify(request.data),
        JSON.stringify(result.data),
        entry.recorded_at,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof AutomationDeliveryLedgerError) throw error;
      throw new AutomationDeliveryLedgerError("failed to record Delivery attempt", "storage_failure", { cause: error });
    }
  }

  async findByRequestId(requestId: string): Promise<AutomationDeliveryLedgerEntry | undefined> {
    try {
      const row = this.getByRequestId(requestId);
      return row ? this.parseRow(row) : undefined;
    } catch (error) {
      if (error instanceof AutomationDeliveryLedgerError) throw error;
      throw new AutomationDeliveryLedgerError("failed to read Delivery request", "storage_failure", { cause: error });
    }
  }

  async findByDeliveryId(deliveryId: string): Promise<AutomationDeliveryLedgerEntry | undefined> {
    try {
      const row = this.getByDeliveryId(deliveryId);
      return row ? this.parseRow(row) : undefined;
    } catch (error) {
      if (error instanceof AutomationDeliveryLedgerError) throw error;
      throw new AutomationDeliveryLedgerError("failed to read Delivery id", "storage_failure", { cause: error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private getByRequestId(requestId: string): DeliveryLedgerRow | undefined {
    return this.db.prepare(`
      select * from automation_delivery_ledger_v1 where request_id = ?
    `).get(requestId) as DeliveryLedgerRow | undefined;
  }

  private getByDeliveryId(deliveryId: string): DeliveryLedgerRow | undefined {
    return this.db.prepare(`
      select * from automation_delivery_ledger_v1 where delivery_id = ?
    `).get(deliveryId) as DeliveryLedgerRow | undefined;
  }

  private parseRow(row: DeliveryLedgerRow): AutomationDeliveryLedgerEntry {
    try {
      const request = AutomationDeliveryRequestSchema.parse(JSON.parse(row.request_json));
      const result = AutomationDeliveryResultSchema.parse(JSON.parse(row.result_json));
      if (request.id !== row.request_id) throw new Error("request id does not match row key");
      if ((result.status === "delivered" ? result.delivery_id : null) !== row.delivery_id) {
        throw new Error("delivery id does not match row key");
      }
      if (!Number.isFinite(Date.parse(row.recorded_at))) throw new Error("recorded_at is invalid");
      return { request, result, recorded_at: row.recorded_at };
    } catch (error) {
      throw new AutomationDeliveryLedgerError(`stored Delivery entry is corrupt: ${row.request_id}`, "corrupt_data", { cause: error });
    }
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists automation_delivery_ledger_v1 (
        request_id text primary key,
        delivery_id text unique,
        request_json text not null,
        result_json text not null,
        recorded_at text not null
      );

      create index if not exists idx_automation_delivery_ledger_v1_recorded
        on automation_delivery_ledger_v1(recorded_at desc);
    `);
  }
}

export class AutomationTraceStoreError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_request" | "corrupt_data" | "storage_failure",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AutomationTraceStoreError";
  }
}

export class SqliteAutomationTraceStore implements AutomationTraceStore {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
  }

  async emit(input: Parameters<AutomationTraceStore["emit"]>[0]): Promise<void> {
    const parsed = AutomationTraceEventSchema.safeParse(input);
    if (!parsed.success) {
      throw new AutomationTraceStoreError("Automation trace event is invalid", "invalid_request", { cause: parsed.error });
    }
    const recordedAt = new Date().toISOString();
    try {
      this.db.prepare(`
        insert into automation_trace_v1 (
          correlation_id, occurred_at, recorded_at, event_json
        ) values (?, ?, ?, ?)
      `).run(
        parsed.data.correlation_id,
        parsed.data.occurred_at,
        recordedAt,
        JSON.stringify(parsed.data),
      );
    } catch (error) {
      throw new AutomationTraceStoreError("failed to append Automation trace event", "storage_failure", { cause: error });
    }
  }

  async query(input: {
    correlation_id: string;
    after_sequence?: number;
    limit?: number;
  }): Promise<AutomationTraceRecord[]> {
    const correlationId = input.correlation_id.trim();
    const afterSequence = input.after_sequence ?? 0;
    const limit = input.limit ?? 1_000;
    if (!correlationId || !Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new AutomationTraceStoreError("invalid Automation trace query", "invalid_request");
    }
    try {
      const rows = this.db.prepare(`
        select * from automation_trace_v1
        where correlation_id = ? and sequence > ?
        order by sequence asc
        limit ?
      `).all(correlationId, afterSequence, limit) as AutomationTraceRow[];
      return rows.map(row => this.parseRow(row));
    } catch (error) {
      if (error instanceof AutomationTraceStoreError) throw error;
      throw new AutomationTraceStoreError("failed to query Automation trace", "storage_failure", { cause: error });
    }
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }

  private parseRow(row: AutomationTraceRow): AutomationTraceRecord {
    try {
      const event = AutomationTraceEventSchema.parse(JSON.parse(row.event_json));
      if (event.correlation_id !== row.correlation_id) throw new Error("correlation id does not match row key");
      if (event.occurred_at !== row.occurred_at) throw new Error("occurred_at does not match row value");
      if (!Number.isInteger(row.sequence) || row.sequence < 1) throw new Error("sequence is invalid");
      if (!Number.isFinite(Date.parse(row.recorded_at))) throw new Error("recorded_at is invalid");
      return { ...event, sequence: row.sequence, recorded_at: row.recorded_at };
    } catch (error) {
      throw new AutomationTraceStoreError(`stored Automation trace is corrupt at sequence ${row.sequence}`, "corrupt_data", { cause: error });
    }
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists automation_trace_v1 (
        sequence integer primary key autoincrement,
        correlation_id text not null,
        occurred_at text not null,
        recorded_at text not null,
        event_json text not null
      );

      create index if not exists idx_automation_trace_v1_correlation_sequence
        on automation_trace_v1(correlation_id, sequence);
    `);
  }
}

function reservationRejection(
  reason: "duplicate" | "cooldown" | "concurrency",
  row: OccurrenceRow | undefined,
): OccurrenceReservation {
  if (!row) {
    throw new AutomationOccurrenceRepositoryError(
      `cannot report ${reason} without an existing occurrence`,
      "corrupt_data",
    );
  }
  return {
    created: false,
    reason,
    correlation_id: row.correlation_id,
    status: row.status,
  };
}

function sameDeliveryEntry(
  left: Pick<AutomationDeliveryLedgerEntry, "request" | "result">,
  right: Pick<AutomationDeliveryLedgerEntry, "request" | "result">,
): boolean {
  return JSON.stringify(left.request) === JSON.stringify(right.request)
    && JSON.stringify(left.result) === JSON.stringify(right.result);
}
