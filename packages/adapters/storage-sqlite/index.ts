import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CaptureBatchSchema,
  CaptureCheckpointSchema,
  CaptureDeadLetterSchema,
  CaptureRuntimeError,
  CaptureSafeErrorSchema,
  CaptureTraceEventSchema,
  ConnectorHealthSchema,
  ConnectorManifestSchema,
  SourceConnectionSchema,
  type CaptureCheckpoint,
  type CaptureDeadLetter,
  type CaptureRuntimeRepository,
  type CommitCaptureBatchInput,
  type CommitCaptureBatchResult,
  type ConnectorHealth,
  type ConnectorManifest,
  type SourceConnection,
  type StoredCaptureTraceEvent,
} from "@info/capture";
import {
  ExecutionAttemptSchema,
  ExecutionRunSchema,
  ExecutionTraceEventSchema,
  parseExecutionAttempt,
  parseExecutionRun,
  parseExecutionTraceEvent,
  type CommitExecutionFailureInput,
  type CommitExecutionSuccessInput,
  type ExecutionAttempt,
  type ExecutionRepository,
  type ExecutionRun,
  type ExecutionTraceEvent,
  type StoredExecutionTraceEvent,
} from "@info/execution";
import {
  ExactViewRefSchema,
  IdentifierSchema,
  ForgetRequestSchema,
  ForgetReplacementSchema,
  ForgetStoreReceiptSchema,
  TimestampSchema,
  VIEW_SEARCH_PROJECTION_IMPLEMENTATION_VERSION,
  ViewMaterializationSchema,
  ViewRelationSchema,
  ViewRevisionTransitionError,
  assertViewRevisionTransition,
  canonicalJson,
  exactViewRef,
  parseView,
  parseViewDraft,
  projectViewForSearch,
  compileViewSearchMatchExpression,
  ReindexViewSearchInputSchema,
  ReindexViewSearchReportSchema,
  AcknowledgeViewCommittedEventInputSchema,
  FailViewCommittedEventInputSchema,
  LeaseViewCommittedEventsInputSchema,
  ListViewCommittedEventsInputSchema,
  ReplayViewCommittedEventInputSchema,
  ViewCommitContextSchema,
  ViewCommittedOutboxEntrySchema,
  ViewCommittedOutboxError,
  parseViewCommittedEvent,
  ViewRepositoryError,
  type CommitViewBatchResult,
  type CommitViewInput,
  type CommitViewResult,
  type AcknowledgeViewCommittedEventInput,
  type ExactViewRef,
  type FailViewCommittedEventInput,
  type ForgetFailure,
  type ForgetRepository,
  type ForgetReplacement,
  type ForgetRequest,
  type ForgetStoreReceipt,
  type PutDerivedMaterializationInput,
  type LeaseViewCommittedEventsInput,
  type ListViewCommittedEventsInput,
  type ReindexViewSearchInput,
  type ReindexViewSearchReport,
  type ReplayViewCommittedEventInput,
  type RelationTraversalQuery,
  type StoredViewMaterialization,
  type View,
  type ViewCommitContext,
  type ViewCommittedEvent,
  type ViewCommittedOutbox,
  type ViewCommittedOutboxEntry,
  type ViewDraft,
  type ViewMaterialization,
  type ViewMaterializationRole,
  type ViewQuery,
  type ViewRelation,
  type ViewRepository,
  type ViewRepositoryErrorCode,
} from "@info/view";
import { SqliteViewSearchAdapter } from "./search-adapter.js";
import {
  deleteSqliteSearchUnits,
  insertSqliteSearchUnits,
  sqliteSearchUnitsMatch,
} from "./search-index.js";
import {
  SQLITE_VEC_EXTENSION_VERSION,
  SqliteVecSemanticSearch,
  SqliteVecSemanticSearchError,
  type SqliteVecProfile,
} from "./semantic-search.js";

export {
  SQLITE_VEC_EMBEDDING_REPRESENTATION_KIND,
  SQLITE_VEC_EMBEDDING_SCHEMA_NAME,
  SQLITE_VEC_EXTENSION_VERSION,
  SQLITE_VEC_MINIMUM_SQLITE_VERSION,
  SQLITE_VEC_PACKAGE_VERSION,
  SqliteVecEmbeddingJsonSchema,
  SqliteVecEmbeddingViewSchema,
  SqliteVecProfileSchema,
  SqliteVecSemanticSearch,
  SqliteVecSemanticSearchError,
  sqliteVecSourceDigest,
  type SqliteVecCompatibilityEvidence,
  type SqliteVecMaintenanceState,
  type SqliteVecProfile,
  type SqliteVecReindexCounts,
} from "./semantic-search.js";

type HeadRow = { revision: number };
type ViewRow = { view_json: string };
type IdempotencyRow = { view_id: string; revision: number; request_fingerprint: string | null };
type CaptureIdentityRow = { view_id: string; first_revision: number };
type RelationRow = {
  id: string;
  type: string;
  source_view_id: string;
  source_revision: number;
  target_view_id: string;
  target_revision: number;
  created_at: string;
  metadata_json: string;
};
type MaterializationRow = {
  view_id: string;
  revision: number;
  materialization_id: string;
  role: ViewMaterializationRole;
  generation: number;
  updated_at: string;
  materialization_json: string;
};
type ColumnRow = { name: string };
type TableInfoRow = ColumnRow & { notnull: number };
type ForeignKeyRow = { table: string };
type ForeignKeyCheckRow = { table: string; rowid: number | null; parent: string; fkid: number };
type StoredMigrationRow = { version: number };
type ExecutionIdempotencyRow = { run_id: string; request_fingerprint: string };
type CaptureConnectionRow = {
  connection_json: string;
  manifest_json: string;
  connection_fingerprint: string;
  checkpoint_json: string;
  health_json: string;
  paused: number;
  in_flight: number;
};
type CaptureBatchRow = { request_fingerprint: string; result_json: string };
type CaptureTraceRow = { sequence: number; event_json: string };
type CaptureDeadLetterRow = { dead_letter_json: string };
type ForgetRequestRow = { status: string; plan_digest: string; request_json: string };
type SearchProjectionRow = {
  search_rowid: number;
  view_id: string;
  revision: number;
  projection_digest: string;
};
type SearchReindexRunRow = {
  status: "running" | "succeeded" | "failed";
  request_fingerprint: string;
  report_json: string | null;
};

type ViewCommitOutboxRow = {
  sequence: number;
  event_id: string;
  status: "pending" | "leased" | "acknowledged" | "poison";
  delivery_attempts: number;
  available_at: string;
  leased_by: string | null;
  lease_expires_at: string | null;
  acknowledged_at: string | null;
  poisoned_at: string | null;
  last_error_json: string | null;
  event_json: string;
};

const VIEW_STORE_MIGRATION_VERSION = 6;
const VIEW_SEARCH_INDEX_MIGRATION_VERSION = 2;

type TransactionContext = {
  id: string;
  operation: string;
  phase: string;
  viewIds: string[];
};

type NormalizedCommit = {
  draft: ViewDraft;
  expectedRevision: number;
  idempotencyKey?: string;
  fingerprint: string;
};

type PlannedCommit = {
  normalized: NormalizedCommit;
  view: View;
  created: boolean;
};

export type SqliteViewRepositoryOptions = {
  busy_timeout_ms?: number;
  now?: () => string;
  event_id_factory?: (transactionId: string) => string;
  semantic_search?: {
    profiles: SqliteVecProfile[];
  };
};

export class SqliteViewRepository implements ViewRepository, ExecutionRepository, CaptureRuntimeRepository, ForgetRepository, ViewCommittedOutbox {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly eventIdFactory: (transactionId: string) => string;
  readonly search: SqliteViewSearchAdapter;
  readonly semantic_search?: SqliteVecSemanticSearch;

  constructor(
    dbPath = process.env.METAFLOW_VIEW_DB_PATH ?? process.env.CONTEXT_DB_PATH ?? "data/context.sqlite",
    options: SqliteViewRepositoryOptions = {},
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.now = options.now ?? (() => new Date().toISOString());
    this.eventIdFactory = options.event_id_factory ?? (transactionId => `view-commit:${transactionId}`);
    try {
      this.db = new DatabaseSync(dbPath, {
        enableForeignKeyConstraints: true,
        timeout: options.busy_timeout_ms ?? 5_000,
        allowExtension: options.semantic_search !== undefined,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
      if (options.semantic_search) {
        this.semantic_search = SqliteVecSemanticSearch.initialize(this.db, options.semantic_search.profiles);
      } else {
        SqliteVecSemanticSearch.assertUnconfiguredDatabase(this.db);
      }
      this.search = new SqliteViewSearchAdapter(this.db);
    } catch (error) {
      if (error instanceof ViewRepositoryError) throw error;
      throw new ViewRepositoryError(
        "failed to initialize SQLite View Store",
        "storage_failure",
        { operation: "migrate", phase: "initialize", sqlite_code: sqliteCode(error) },
        { cause: error },
      );
    }
  }

  async commit(input: CommitViewInput, context?: ViewCommitContext): Promise<CommitViewResult> {
    const batch = await this.commitBatch([input], context);
    const result = batch.results[0];
    if (!result) {
      throw new ViewRepositoryError(
        "single View commit produced no result",
        "corrupt_data",
        { operation: "commit", transaction_id: batch.transaction_id },
      );
    }
    return result;
  }

  async commitBatch(inputs: CommitViewInput[], context?: ViewCommitContext): Promise<CommitViewBatchResult> {
    const normalized = this.normalizeCommits(inputs);
    const transaction = this.transactionContext("commit_batch", normalized.map(item => item.draft.id));
    return this.withTransaction(transaction, () => {
      transaction.phase = "plan";
      const plans = this.planCommits(normalized, transaction);
      transaction.phase = "validate_references";
      this.validatePlannedReferences(plans, transaction);
      transaction.phase = "persist";
      for (const plan of plans) {
        if (plan.created) this.persistPlan(plan, transaction);
      }
      transaction.phase = "persist_semantic_search";
      const plannedViews = new Map(
        plans.filter(plan => plan.created).map(plan => [viewKey(exactViewRef(plan.view)), plan.view]),
      );
      for (const plan of plans) {
        if (plan.created) this.persistSemanticSearch(plan.view, plannedViews, transaction);
      }
      transaction.phase = "persist_view_committed_event";
      this.persistViewCommittedEvent(plans, transaction, context);
      return {
        transaction_id: transaction.id,
        results: plans.map(plan => ({
          view: plan.view,
          created: plan.created,
          transaction_id: transaction.id,
        })),
      };
    });
  }

  async createForgetRequest(requestValue: ForgetRequest): Promise<{ request: ForgetRequest; created: boolean }> {
    const request = ForgetRequestSchema.parse(requestValue);
    const transaction = this.transactionContext("forget_create_request", request.plan.impact.map(item => item.ref.view_id));
    return this.withTransaction(transaction, () => {
      transaction.phase = "check_request";
      const existing = this.readForgetRequestRow(request.plan.request_id);
      if (existing) {
        if (existing.plan_digest !== request.plan.plan_digest) {
          throw this.problem(
            "idempotency_conflict",
            `Forget request ${request.plan.request_id} was reused with a different impact plan`,
            transaction,
          );
        }
        return { request: this.parseForgetRequest(existing.request_json), created: false };
      }
      transaction.phase = "persist_request";
      this.db.prepare(`
        insert into privacy_forget_requests_v1 (
          request_id, status, plan_digest, created_at, updated_at, request_json
        ) values (?, ?, ?, ?, ?, ?)
      `).run(
        request.plan.request_id,
        request.status,
        request.plan.plan_digest,
        request.created_at,
        request.updated_at,
        JSON.stringify(request),
      );
      return { request, created: true };
    });
  }

  async getForgetRequest(requestId: string): Promise<ForgetRequest | undefined> {
    const id = requiredString(requestId, "requestId", "forget_get_request");
    return this.read("forget_get_request", () => {
      const row = this.readForgetRequestRow(id);
      return row ? this.parseForgetRequest(row.request_json) : undefined;
    });
  }

  async startForgetRequest(
    requestId: string,
    updatedAtValue: string,
    recoverRunning = false,
  ): Promise<ForgetRequest> {
    const id = requiredString(requestId, "requestId", "forget_start_request");
    const updatedAt = TimestampSchema.parse(updatedAtValue);
    const transaction = this.transactionContext("forget_start_request", []);
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_request";
      const request = this.mustReadForgetRequest(id, transaction);
      if (request.status === "succeeded") return request;
      if (request.status === "running" && !recoverRunning) {
        throw this.problem("conflict", `Forget request ${id} is already running`, transaction);
      }
      transaction.phase = "persist_running";
      const { failure: _failure, ...requestWithoutFailure } = request;
      const running = ForgetRequestSchema.parse({
        ...requestWithoutFailure,
        status: "running",
        updated_at: updatedAt,
      });
      this.writeForgetRequest(running);
      return running;
    });
  }

  async recordForgetStoreReceipt(input: {
    request_id: string;
    receipt: ForgetStoreReceipt;
  }): Promise<ForgetRequest> {
    const id = requiredString(input.request_id, "request_id", "forget_record_store_receipt");
    const receipt = ForgetStoreReceiptSchema.parse(input.receipt);
    const transaction = this.transactionContext("forget_record_store_receipt", []);
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_request";
      const request = this.mustReadForgetRequest(id, transaction);
      if (request.status !== "running") {
        throw this.problem("conflict", `Forget request ${id} is not running`, transaction);
      }
      const index = request.receipts.findIndex(item => item.store_id === receipt.store_id);
      if (index < 0) throw this.problem("invalid_request", `Unknown Forget store ${receipt.store_id}`, transaction);
      const receipts = [...request.receipts];
      receipts[index] = receipt;
      transaction.phase = "persist_receipt";
      const next = ForgetRequestSchema.parse({
        ...request,
        receipts,
        updated_at: receipt.updated_at,
      });
      this.writeForgetRequest(next);
      return next;
    });
  }

  async failForgetRequest(input: {
    request_id: string;
    failure: ForgetFailure;
    failed_at: string;
  }): Promise<ForgetRequest> {
    const id = requiredString(input.request_id, "request_id", "forget_fail_request");
    const failedAt = TimestampSchema.parse(input.failed_at);
    const transaction = this.transactionContext("forget_fail_request", []);
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_request";
      const request = this.mustReadForgetRequest(id, transaction);
      if (request.status === "succeeded") {
        throw this.problem("conflict", `Succeeded Forget request ${id} cannot fail`, transaction);
      }
      transaction.phase = "persist_failure";
      const failed = ForgetRequestSchema.parse({
        ...request,
        status: "failed",
        failure: input.failure,
        updated_at: failedAt,
      });
      this.writeForgetRequest(failed);
      return failed;
    });
  }

  async commitForgetSuccess(input: {
    request_id: string;
    refs: ExactViewRef[];
    replacements: ForgetReplacement[];
    completed_at: string;
  }): Promise<ForgetRequest> {
    const id = requiredString(input.request_id, "request_id", "forget_commit_success");
    const refs = input.refs.map(ref => this.parseExactRef(ref, "forget_commit_success"));
    const replacements = input.replacements.map(item => ForgetReplacementSchema.parse(item));
    const completedAt = TimestampSchema.parse(input.completed_at);
    const transaction = this.transactionContext("forget_commit_success", refs.map(ref => ref.view_id));
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_request";
      const request = this.mustReadForgetRequest(id, transaction);
      if (request.status === "succeeded") return request;
      if (request.status !== "running") {
        throw this.problem("conflict", `Forget request ${id} is not running`, transaction);
      }
      const expected = request.plan.impact.map(item => viewKey(item.ref)).sort();
      const actual = refs.map(viewKey).sort();
      if (canonicalJson(expected) !== canonicalJson(actual)) {
        throw this.problem("invalid_request", "Forget purge refs do not match the frozen impact plan", transaction);
      }
      for (const ref of refs) {
        if (!this.exactViewExists(ref)) {
          throw this.problem("referential_integrity", `Forget impact View ${viewKey(ref)} is missing`, transaction);
        }
      }
      for (const replacement of replacements) {
        if (!this.exactViewExists(replacement.rebuilt)) {
          throw this.problem("referential_integrity", `Forget rebuilt View ${viewKey(replacement.rebuilt)} is missing`, transaction);
        }
        if (!actual.includes(viewKey(replacement.forgotten))) {
          throw this.problem("invalid_request", "Forget replacement does not map a frozen impact View", transaction);
        }
      }

      transaction.phase = "purge_pending_view_commit_events";
      const governedEvents = new Set<string>();
      const findEvents = this.db.prepare(`
        select event_id from view_commit_outbox_refs_v1 where view_id = ? and revision = ?
      `);
      for (const ref of refs) {
        const rows = findEvents.all(ref.view_id, ref.revision) as Array<{ event_id: string }>;
        for (const row of rows) governedEvents.add(row.event_id);
      }
      const removeUndeliveredEvent = this.db.prepare(`
        delete from view_commit_outbox_v1 where event_id = ? and status != 'acknowledged'
      `);
      for (const eventId of governedEvents) removeUndeliveredEvent.run(eventId);

      transaction.phase = "purge_indexes_and_materializations";
      for (const ref of refs) {
        this.deleteSearchProjection(ref);
        this.db.prepare("delete from view_idempotency_v1 where view_id = ? and revision = ?")
          .run(ref.view_id, ref.revision);
        this.db.prepare(`
          delete from view_relations_v1
          where (source_view_id = ? and source_revision = ?)
             or (target_view_id = ? and target_revision = ?)
        `).run(ref.view_id, ref.revision, ref.view_id, ref.revision);
        this.db.prepare("delete from view_materializations_v1 where view_id = ? and revision = ?")
          .run(ref.view_id, ref.revision);
      }
      const impactedIds = [...new Set(refs.map(ref => ref.view_id))];
      transaction.phase = "retire_view_identities";
      const retireIdentity = this.db.prepare(`
        insert into privacy_forgotten_view_ids_v1 (view_id, request_id, forgotten_at)
        values (?, ?, ?)
      `);
      for (const viewId of impactedIds) retireIdentity.run(viewId, id, completedAt);

      transaction.phase = "purge_identity_indexes";
      for (const viewId of impactedIds) {
        this.db.prepare("delete from view_heads_v1 where id = ?").run(viewId);
        this.db.prepare("delete from view_capture_identities_v1 where view_id = ?").run(viewId);
      }

      transaction.phase = "purge_view_payloads";
      for (const ref of refs) {
        this.db.prepare("delete from view_revisions_v1 where id = ? and revision = ?")
          .run(ref.view_id, ref.revision);
      }
      for (const viewId of impactedIds) {
        const remaining = this.db.prepare(`
          select revision, created_at from view_revisions_v1 where id = ? order by revision desc limit 1
        `).get(viewId) as { revision: number; created_at: string } | undefined;
        if (remaining) {
          this.db.prepare("insert into view_heads_v1 (id, revision, updated_at) values (?, ?, ?)")
            .run(viewId, Number(remaining.revision), completedAt);
        }
      }

      transaction.phase = "persist_content_free_audit";
      const receipts = request.receipts.map(receipt => receipt.store_id === "view-store"
        ? ForgetStoreReceiptSchema.parse({
            store_id: receipt.store_id,
            status: "succeeded",
            attempts: receipt.attempts + 1,
            updated_at: completedAt,
          })
        : receipt);
      if (receipts.some(receipt => receipt.status !== "succeeded")) {
        throw this.problem("conflict", "Forget cannot succeed before every governed store confirms deletion", transaction);
      }
      const { failure: _failure, ...requestWithoutFailure } = request;
      const succeeded = ForgetRequestSchema.parse({
        ...requestWithoutFailure,
        status: "succeeded",
        receipts,
        replacements,
        updated_at: completedAt,
        completed_at: completedAt,
      });
      this.writeForgetRequest(succeeded);
      return succeeded;
    });
  }

  async createRun(run: ExecutionRun): Promise<{ run: ExecutionRun; created: boolean }> {
    const parsed = parseExecutionRun(run);
    if (parsed.status !== "ready") {
      throw new ViewRepositoryError(
        "A new Execution Run must be ready",
        "invalid_request",
        { operation: "execution_create_run" },
      );
    }
    const transaction = this.transactionContext("execution_create_run", []);
    return this.withTransaction(transaction, () => {
      const idempotencyKey = parsed.frozen.idempotency_key;
      const fingerprint = executionRunFingerprint(parsed);
      if (idempotencyKey) {
        transaction.phase = "check_idempotency";
        const replay = this.db.prepare(`
          select run_id, request_fingerprint from execution_idempotency_v1 where idempotency_key = ?
        `).get(idempotencyKey) as ExecutionIdempotencyRow | undefined;
        if (replay) {
          if (replay.request_fingerprint !== fingerprint) {
            throw new ViewRepositoryError(
              `Execution idempotency key ${idempotencyKey} was reused with different frozen input`,
              "idempotency_conflict",
              { operation: transaction.operation, phase: transaction.phase, transaction_id: transaction.id, idempotency_key: idempotencyKey },
            );
          }
          return { run: this.mustReadExecutionRun(replay.run_id), created: false };
        }
      }
      transaction.phase = "persist_run";
      this.db.prepare(`
        insert into execution_runs_v1 (run_id, status, created_at, updated_at, run_json)
        values (?, ?, ?, ?, ?)
      `).run(parsed.id, parsed.status, parsed.created_at, parsed.created_at, JSON.stringify(parsed));
      if (idempotencyKey) {
        transaction.phase = "persist_idempotency";
        this.db.prepare(`
          insert into execution_idempotency_v1 (idempotency_key, request_fingerprint, run_id, created_at)
          values (?, ?, ?, ?)
        `).run(idempotencyKey, fingerprint, parsed.id, parsed.created_at);
      }
      return { run: parsed, created: true };
    });
  }

  async updateRunStarted(input: { run_id: string; attempt: ExecutionAttempt; started_at: string }): Promise<void> {
    const attempt = parseExecutionAttempt(input.attempt);
    if (attempt.run_id !== input.run_id || attempt.status !== "running" || attempt.started_at !== input.started_at) {
      throw new ViewRepositoryError(
        "Execution attempt does not match the requested Run start",
        "invalid_request",
        { operation: "execution_start_attempt" },
      );
    }
    const transaction = this.transactionContext("execution_start_attempt", []);
    this.withTransaction(transaction, () => {
      transaction.phase = "read_run";
      const run = this.mustReadExecutionRun(input.run_id);
      if (run.status !== "ready") {
        throw new ViewRepositoryError(
          `Execution Run ${run.id} cannot start from ${run.status}`,
          "conflict",
          { operation: transaction.operation, phase: transaction.phase, transaction_id: transaction.id },
        );
      }
      if (attempt.previous_attempt_id) {
        const previous = this.db.prepare(`
          select attempt_id from execution_attempts_v1 where attempt_id = ?
        `).get(attempt.previous_attempt_id) as { attempt_id: string } | undefined;
        if (!previous) {
          throw new ViewRepositoryError(
            `Linked previous attempt ${attempt.previous_attempt_id} does not exist`,
            "referential_integrity",
            { operation: transaction.operation, phase: "validate_attempt_link", transaction_id: transaction.id },
          );
        }
      }
      transaction.phase = "persist_attempt";
      this.insertExecutionAttempt(attempt);
      const started = ExecutionRunSchema.parse({ ...run, status: "running", started_at: input.started_at });
      this.updateExecutionRun(started, input.started_at);
    });
  }

  async appendTrace(event: ExecutionTraceEvent): Promise<StoredExecutionTraceEvent> {
    const parsed = parseExecutionTraceEvent(event);
    if (parsed.sequence !== undefined) {
      throw new ViewRepositoryError(
        "Execution trace sequence is assigned by the repository",
        "invalid_request",
        { operation: "execution_append_trace" },
      );
    }
    const transaction = this.transactionContext("execution_append_trace", []);
    return this.withTransaction(transaction, () => {
      transaction.phase = "validate_run";
      this.mustReadExecutionRun(parsed.run_id);
      transaction.phase = "persist_event";
      return this.insertExecutionTrace(parsed);
    });
  }

  async commitSuccess(input: CommitExecutionSuccessInput): Promise<CommitViewBatchResult> {
    const attempt = parseExecutionAttempt(input.attempt);
    if (attempt.status !== "succeeded" || attempt.run_id !== input.run_id) {
      throw new ViewRepositoryError(
        "Successful Execution commit requires a succeeded attempt for the same Run",
        "invalid_request",
        { operation: "execution_commit_success" },
      );
    }
    const normalized = this.normalizeCommits(input.outputs);
    const transaction = this.transactionContext("execution_commit_success", normalized.map(item => item.draft.id));
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_run";
      const run = this.mustReadExecutionRun(input.run_id);
      this.assertRunningAttempt(run, attempt, transaction);
      transaction.phase = "plan_views";
      const plans = this.planCommits(normalized, transaction);
      transaction.phase = "validate_references";
      this.validatePlannedReferences(plans, transaction);
      transaction.phase = "persist_views";
      for (const plan of plans) if (plan.created) this.persistPlan(plan, transaction);
      transaction.phase = "persist_view_committed_event";
      this.persistViewCommittedEvent(plans, transaction, {
        batch_id: input.run_id,
        committed_at: input.completed_at,
        origin: { kind: "execution", id: input.run_id },
        ...(input.cascade ? { cascade: input.cascade } : {}),
      });
      transaction.phase = "finalize_attempt";
      this.updateExecutionAttempt(attempt);
      const outputs = plans.map(plan => exactViewRef(plan.view));
      const completed = ExecutionRunSchema.parse({
        ...run,
        status: "succeeded",
        completed_at: input.completed_at,
        output_views: outputs,
        total_cost_usd: input.cost_usd,
      });
      this.updateExecutionRun(completed, input.completed_at);
      transaction.phase = "persist_terminal_event";
      this.insertExecutionTrace(input.terminal_event);
      return {
        transaction_id: transaction.id,
        results: plans.map(plan => ({
          view: plan.view,
          created: plan.created,
          transaction_id: transaction.id,
        })),
      };
    });
  }

  async commitFailure(input: CommitExecutionFailureInput): Promise<CommitViewBatchResult> {
    const attempt = input.attempt ? parseExecutionAttempt(input.attempt) : undefined;
    if (attempt && (attempt.run_id !== input.run_id || attempt.status === "running" || attempt.status === "succeeded")) {
      throw new ViewRepositoryError(
        "Failure commit requires a terminal unsuccessful attempt for the same Run",
        "invalid_request",
        { operation: "execution_commit_failure" },
      );
    }
    const normalized = this.normalizeCommits([...(input.artifacts ?? []), input.failure]);
    const transaction = this.transactionContext("execution_commit_failure", normalized.map(item => item.draft.id));
    return this.withTransaction(transaction, () => {
      transaction.phase = "read_run";
      const run = this.mustReadExecutionRun(input.run_id);
      if (attempt) this.assertRunningAttempt(run, attempt, transaction);
      else if (run.status !== "ready") {
        throw new ViewRepositoryError(
          `Execution Run ${run.id} cannot fail without an attempt from ${run.status}`,
          "conflict",
          { operation: transaction.operation, phase: transaction.phase, transaction_id: transaction.id },
        );
      }
      transaction.phase = "plan_failure_view";
      const plans = this.planCommits(normalized, transaction);
      transaction.phase = "validate_references";
      this.validatePlannedReferences(plans, transaction);
      transaction.phase = "persist_failure_view";
      for (const plan of plans) if (plan.created) this.persistPlan(plan, transaction);
      transaction.phase = "persist_view_committed_event";
      this.persistViewCommittedEvent(plans, transaction, {
        batch_id: input.run_id,
        committed_at: input.completed_at,
        origin: { kind: "execution", id: input.run_id },
        ...(input.cascade ? { cascade: input.cascade } : {}),
      });
      if (attempt) {
        transaction.phase = "finalize_attempt";
        this.updateExecutionAttempt(attempt);
      }
      const failurePlan = plans.find(plan => plan.view.id === input.failure.draft.id);
      if (!failurePlan) {
        throw new ViewRepositoryError(
          `Failure batch does not contain ${input.failure.draft.id}`,
          "corrupt_data",
          { operation: transaction.operation, phase: "resolve_failure_view", transaction_id: transaction.id },
        );
      }
      const failureRef = exactViewRef(failurePlan.view);
      const completed = ExecutionRunSchema.parse({
        ...run,
        status: input.status,
        completed_at: input.completed_at,
        failure_view: failureRef,
        total_cost_usd: input.cost_usd,
        error: input.error,
      });
      this.updateExecutionRun(completed, input.completed_at);
      transaction.phase = "persist_terminal_event";
      this.insertExecutionTrace(input.terminal_event);
      return {
        transaction_id: transaction.id,
        results: plans.map(plan => ({
          view: plan.view,
          created: plan.created,
          transaction_id: transaction.id,
        })),
      };
    });
  }

  async getRun(runId: string): Promise<ExecutionRun | undefined> {
    const id = requiredString(runId, "runId", "execution_get_run");
    return this.read("execution_get_run", () => this.tryReadExecutionRun(id));
  }

  async getRunByIdempotencyKey(idempotencyKey: string): Promise<ExecutionRun | undefined> {
    const key = requiredString(idempotencyKey, "idempotencyKey", "execution_get_run_by_idempotency");
    return this.read("execution_get_run_by_idempotency", () => {
      const row = this.db.prepare(`
        select run_id from execution_idempotency_v1 where idempotency_key = ?
      `).get(key) as { run_id: string } | undefined;
      return row ? this.mustReadExecutionRun(row.run_id) : undefined;
    });
  }

  async getAttempts(runId: string): Promise<ExecutionAttempt[]> {
    const id = requiredString(runId, "runId", "execution_get_attempts");
    return this.read("execution_get_attempts", () => {
      const rows = this.db.prepare(`
        select attempt_json from execution_attempts_v1 where run_id = ? order by sequence, attempt_id
      `).all(id) as Array<{ attempt_json: string }>;
      return rows.map(row => this.parseStoredExecutionAttempt(row.attempt_json));
    });
  }

  async getTrace(runId: string): Promise<StoredExecutionTraceEvent[]> {
    const id = requiredString(runId, "runId", "execution_get_trace");
    return this.read("execution_get_trace", () => {
      const rows = this.db.prepare(`
        select sequence, event_json from execution_trace_v1 where run_id = ? order by sequence
      `).all(id) as Array<{ sequence: number; event_json: string }>;
      return rows.map(row => {
        const event = parseExecutionTraceEvent({ ...JSON.parse(row.event_json), sequence: Number(row.sequence) });
        return event as StoredExecutionTraceEvent;
      });
    });
  }

  private tryReadExecutionRun(runId: string): ExecutionRun | undefined {
    const row = this.db.prepare(`
      select run_json from execution_runs_v1 where run_id = ?
    `).get(runId) as { run_json: string } | undefined;
    return row ? this.parseStoredExecutionRun(row.run_json) : undefined;
  }

  private mustReadExecutionRun(runId: string): ExecutionRun {
    const run = this.tryReadExecutionRun(runId);
    if (!run) {
      throw new ViewRepositoryError(
        `Execution Run ${runId} does not exist`,
        "referential_integrity",
        { operation: "execution_read_run" },
      );
    }
    return run;
  }

  private parseStoredExecutionRun(value: string): ExecutionRun {
    try {
      return parseExecutionRun(JSON.parse(value));
    } catch (error) {
      throw new ViewRepositoryError(
        "stored Execution Run failed validation",
        "corrupt_data",
        { operation: "execution_parse_run" },
        { cause: error },
      );
    }
  }

  private parseStoredExecutionAttempt(value: string): ExecutionAttempt {
    try {
      return parseExecutionAttempt(JSON.parse(value));
    } catch (error) {
      throw new ViewRepositoryError(
        "stored Execution attempt failed validation",
        "corrupt_data",
        { operation: "execution_parse_attempt" },
        { cause: error },
      );
    }
  }

  private insertExecutionAttempt(attempt: ExecutionAttempt): void {
    this.db.prepare(`
      insert into execution_attempts_v1 (
        attempt_id, run_id, sequence, previous_attempt_id, status, started_at, completed_at, attempt_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attempt.id,
      attempt.run_id,
      attempt.sequence,
      attempt.previous_attempt_id ?? null,
      attempt.status,
      attempt.started_at,
      attempt.completed_at ?? null,
      JSON.stringify(attempt),
    );
  }

  private updateExecutionAttempt(attempt: ExecutionAttempt): void {
    const changed = this.db.prepare(`
      update execution_attempts_v1
      set status = ?, completed_at = ?, attempt_json = ?
      where attempt_id = ? and run_id = ? and status = 'running'
    `).run(
      attempt.status,
      attempt.completed_at ?? null,
      JSON.stringify(attempt),
      attempt.id,
      attempt.run_id,
    );
    if (Number(changed.changes) !== 1) {
      throw new ViewRepositoryError(
        `Execution attempt ${attempt.id} is missing or already terminal`,
        "conflict",
        { operation: "execution_update_attempt" },
      );
    }
  }

  private updateExecutionRun(run: ExecutionRun, updatedAt: string): void {
    const changed = this.db.prepare(`
      update execution_runs_v1 set status = ?, updated_at = ?, run_json = ? where run_id = ?
    `).run(run.status, updatedAt, JSON.stringify(run), run.id);
    if (Number(changed.changes) !== 1) {
      throw new ViewRepositoryError(
        `Execution Run ${run.id} disappeared while updating`,
        "corrupt_data",
        { operation: "execution_update_run" },
      );
    }
  }

  private assertRunningAttempt(
    run: ExecutionRun,
    terminalAttempt: ExecutionAttempt,
    transaction: TransactionContext,
  ): void {
    if (run.status !== "running") {
      throw new ViewRepositoryError(
        `Execution Run ${run.id} cannot finalize from ${run.status}`,
        "conflict",
        { operation: transaction.operation, phase: transaction.phase, transaction_id: transaction.id },
      );
    }
    const row = this.db.prepare(`
      select attempt_json from execution_attempts_v1 where attempt_id = ? and run_id = ?
    `).get(terminalAttempt.id, run.id) as { attempt_json: string } | undefined;
    const stored = row ? this.parseStoredExecutionAttempt(row.attempt_json) : undefined;
    if (!stored || stored.status !== "running") {
      throw new ViewRepositoryError(
        `Execution attempt ${terminalAttempt.id} is not the active attempt for Run ${run.id}`,
        "conflict",
        { operation: transaction.operation, phase: "validate_attempt", transaction_id: transaction.id },
      );
    }
    const frozenStored = ExecutionAttemptSchema.parse({
      ...stored,
      status: terminalAttempt.status,
      completed_at: terminalAttempt.completed_at,
      duration_ms: terminalAttempt.duration_ms,
      cost_usd: terminalAttempt.cost_usd,
      ...(terminalAttempt.error ? { error: terminalAttempt.error } : {}),
    });
    if (canonicalJson(frozenStored) !== canonicalJson(terminalAttempt)) {
      throw new ViewRepositoryError(
        `Execution attempt ${terminalAttempt.id} changed frozen fields`,
        "conflict",
        { operation: transaction.operation, phase: "validate_attempt", transaction_id: transaction.id },
      );
    }
  }

  private insertExecutionTrace(event: ExecutionTraceEvent): StoredExecutionTraceEvent {
    const parsed = ExecutionTraceEventSchema.parse(event);
    if (parsed.sequence !== undefined) {
      throw new ViewRepositoryError(
        "Execution trace sequence is assigned by SQLite",
        "invalid_request",
        { operation: "execution_insert_trace" },
      );
    }
    if (parsed.attempt_id) {
      const attempt = this.db.prepare(`
        select run_id from execution_attempts_v1 where attempt_id = ?
      `).get(parsed.attempt_id) as { run_id: string } | undefined;
      if (!attempt || attempt.run_id !== parsed.run_id) {
        throw new ViewRepositoryError(
          `Execution trace references an unknown attempt ${parsed.attempt_id}`,
          "referential_integrity",
          { operation: "execution_insert_trace" },
        );
      }
    }
    const inserted = this.db.prepare(`
      insert into execution_trace_v1 (run_id, attempt_id, type, occurred_at, event_json)
      values (?, ?, ?, ?, ?)
    `).run(
      parsed.run_id,
      parsed.attempt_id ?? null,
      parsed.type,
      parsed.occurred_at,
      JSON.stringify(parsed),
    );
    return { ...parsed, sequence: Number(inserted.lastInsertRowid) };
  }

  async get(ref: ExactViewRef): Promise<View | undefined> {
    const exact = this.parseExactRef(ref, "get");
    return this.read("get", () => this.tryReadStoredView(exact.view_id, exact.revision));
  }

  async getLatest(viewId: string): Promise<View | undefined> {
    const id = requiredString(viewId, "viewId", "get_latest");
    return this.read("get_latest", () => this.tryReadLatestView(id));
  }

  async resolveLatest(viewId: string): Promise<ExactViewRef | undefined> {
    const id = requiredString(viewId, "viewId", "resolve_latest");
    return this.read("resolve_latest", () => {
      const head = this.readHead(id);
      return head ? { view_id: id, revision: Number(head.revision) } : undefined;
    });
  }

  async query(query: ViewQuery = {}): Promise<View[]> {
    return this.read("query", () => {
      if (query.revisions !== undefined && query.revisions !== "latest" && query.revisions !== "all") {
        throw invalidRequest("query revisions must be latest or all", "query");
      }
      if (query.role !== undefined && query.role !== "raw" && query.role !== "derived") {
        throw invalidRequest("query role must be raw or derived", "query");
      }
      if (query.schema_name !== undefined && (typeof query.schema_name !== "string" || !query.schema_name.trim())) {
        throw invalidRequest("query schema_name must be a non-empty string", "query");
      }
      const schemaNames = query.schema_names === undefined
        ? undefined
        : queryList(query.schema_names, "schema_names", value => typeof value === "string" && Boolean(value.trim()));
      if (query.schema_name !== undefined && schemaNames !== undefined) {
        throw invalidRequest("query cannot combine schema_name and schema_names", "query");
      }
      if (query.text !== undefined && (typeof query.text !== "string" || !query.text.trim())) {
        throw invalidRequest("query text must be a non-empty string", "query");
      }
      const timestampRange = query.time_range === undefined
        ? undefined
        : parseQueryTimeRange(query.time_range);
      const limit = boundedLimit(query.limit, 100, 10_000, "query");
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      if (query.schema_name) {
        clauses.push("r.schema_name = ?");
        values.push(query.schema_name);
      }
      if (schemaNames) {
        clauses.push(`r.schema_name in (${sqlPlaceholders(schemaNames.length)})`);
        values.push(...schemaNames);
      }
      if (query.role) {
        clauses.push("r.role = ?");
        values.push(query.role);
      }
      let searchExpression: string | undefined;
      if (query.text) {
        try {
          searchExpression = compileViewSearchMatchExpression(query.text);
        } catch (error) {
          throw new ViewRepositoryError(
            "query text does not contain searchable tokens",
            "invalid_request",
            { operation: "query", phase: "validate_input" },
            { cause: error },
          );
        }
        clauses.push("view_search_fts_v1 match ?");
        values.push(searchExpression);
      }
      if (timestampRange) {
        const timestampExpression = timestampRange.basis === "created_at"
          ? "unixepoch(r.created_at, 'subsec')"
          : "unixepoch(json_extract(r.view_json, '$.time.observed_at'), 'subsec')";
        clauses.push(`${timestampExpression} >= ?`);
        clauses.push(`${timestampExpression} < ?`);
        values.push(timestampRange.startEpochSeconds, timestampRange.endEpochSeconds);
      }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      const revisionFrom = query.revisions === "all"
        ? "view_revisions_v1 r"
        : "view_heads_v1 h join view_revisions_v1 r on r.id = h.id and r.revision = h.revision";
      const from = searchExpression
        ? `${revisionFrom}
           join view_search_projection_v1 sp on sp.view_id = r.id and sp.revision = r.revision
           join view_search_fts_v1 on view_search_fts_v1.rowid = sp.search_rowid`
        : revisionFrom;
      const order = searchExpression
        ? `bm25(view_search_fts_v1, 12.0, 6.0, 4.0, 3.0, 2.0, 1.0) asc,
           unixepoch(r.created_at, 'subsec') desc, r.id asc, r.revision desc`
        : "unixepoch(r.created_at, 'subsec') desc, r.id asc, r.revision desc";
      const rows = this.db.prepare(`
        select r.view_json
        from ${from}
        ${where}
        order by ${order}
        limit ?
      `).all(...values, limit) as ViewRow[];
      return rows.map(row => this.parseStoredJson(row.view_json));
    });
  }

  async reindexSearch(inputValue: ReindexViewSearchInput): Promise<ReindexViewSearchReport> {
    let input: ReindexViewSearchInput;
    try {
      input = ReindexViewSearchInputSchema.parse(inputValue);
    } catch (error) {
      throw new ViewRepositoryError(
        "invalid View search reindex request",
        "invalid_request",
        { operation: "search_reindex", phase: "validate_input" },
        { cause: error },
      );
    }
    const fingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const start = this.transactionContext("search_reindex_start", []);
    const existingReport = this.withTransaction(start, () => {
      start.phase = "reserve_run";
      const existing = this.db.prepare(`
        select status, request_fingerprint, report_json
        from view_search_reindex_runs_v1 where run_id = ?
      `).get(input.run_id) as SearchReindexRunRow | undefined;
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw this.problem("idempotency_conflict", `Search reindex run ${input.run_id} was reused with different input`, start);
        }
        if (existing.status === "succeeded") {
          if (!existing.report_json) throw this.problem("corrupt_data", `Search reindex run ${input.run_id} has no report`, start);
          return ReindexViewSearchReportSchema.parse(parseJson(existing.report_json, "search reindex report"));
        }
        if (existing.status === "failed") {
          throw this.problem("conflict", `Search reindex run ${input.run_id} already failed; retry with a new run id`, start);
        }
        return undefined;
      }
      this.db.prepare(`
        insert into view_search_reindex_runs_v1 (
          run_id, status, request_fingerprint, started_at, completed_at, report_json, error_json
        ) values (?, 'running', ?, ?, null, null, null)
      `).run(input.run_id, fingerprint, input.requested_at);
      return undefined;
    });
    if (existingReport) {
      if (this.semantic_search?.refreshMaintenanceState().status === "reindex_required") {
        throw new ViewRepositoryError(
          `Search reindex run ${input.run_id} predates current semantic corruption; retry with a new run id`,
          "conflict",
          { operation: "search_reindex", phase: "replay_requires_new_run" },
        );
      }
      return existingReport;
    }

    const transaction = this.transactionContext("search_reindex", []);
    let markSemanticCommitted: (() => void) | undefined;
    try {
      const report = this.withTransaction(transaction, () => {
        transaction.phase = "rebuild_projection";
        const counts = this.rebuildSearchProjection(input.requested_at);
        const semanticRebuild = this.semantic_search
          ? this.semantic_search.rebuild(this.readAllStoredViews())
          : undefined;
        markSemanticCommitted = semanticRebuild?.mark_committed;
        const semantic = semanticRebuild?.counts;
        const report = ReindexViewSearchReportSchema.parse({
          run_id: input.run_id,
          status: "succeeded",
          projection_version: VIEW_SEARCH_PROJECTION_IMPLEMENTATION_VERSION,
          ...counts,
          ...(semantic ? {
            semantic: {
              adapter: "sqlite-vec",
              extension_version: SQLITE_VEC_EXTENSION_VERSION,
              profiles: this.semantic_search!.compatibility.profiles.length,
              ...semantic,
            },
          } : {}),
          started_at: input.requested_at,
          completed_at: new Date().toISOString(),
        });
        transaction.phase = "persist_report";
        const updated = this.db.prepare(`
          update view_search_reindex_runs_v1
          set status = 'succeeded', completed_at = ?, report_json = ?, error_json = null
          where run_id = ? and status = 'running'
        `).run(report.completed_at, JSON.stringify(report), input.run_id);
        if (Number(updated.changes) !== 1) {
          throw this.problem("conflict", `Search reindex run ${input.run_id} is not running`, transaction);
        }
        return report;
      });
      markSemanticCommitted?.();
      return report;
    } catch (error) {
      const failedAt = new Date().toISOString();
      const failure = this.transactionContext("search_reindex_fail", []);
      this.withTransaction(failure, () => {
        failure.phase = "persist_failure";
        this.db.prepare(`
          update view_search_reindex_runs_v1
          set status = 'failed', completed_at = ?, error_json = ?
          where run_id = ? and status = 'running'
        `).run(failedAt, JSON.stringify(searchReindexSafeError(error)), input.run_id);
      });
      throw error;
    }
  }

  async getRepresentation(ref: ExactViewRef) {
    return (await this.get(ref))?.representation;
  }

  async getMaterializations(ref: ExactViewRef): Promise<StoredViewMaterialization[]> {
    const exact = this.parseExactRef(ref, "get_materializations");
    return this.read("get_materializations", () => {
      if (!this.exactViewExists(exact)) {
        throw new ViewRepositoryError(
          `View ${viewKey(exact)} does not exist`,
          "referential_integrity",
          { operation: "get_materializations", view_ids: [exact.view_id] },
        );
      }
      const rows = this.db.prepare(`
        select view_id, revision, materialization_id, role, generation, updated_at, materialization_json
        from view_materializations_v1
        where view_id = ? and revision = ?
        order by case role when 'primary' then 0 when 'alternative' then 1 else 2 end,
                 materialization_id asc
      `).all(exact.view_id, exact.revision) as MaterializationRow[];
      if (rows.length === 0) {
        throw new ViewRepositoryError(
          `View ${viewKey(exact)} has no persisted primary Materialization`,
          "corrupt_data",
          { operation: "get_materializations", view_ids: [exact.view_id] },
        );
      }
      const materializations = rows.map(row => this.parseMaterializationRow(row));
      this.assertManifestMaterializations(this.mustReadStoredView(exact.view_id, exact.revision), materializations, "get_materializations");
      return materializations;
    });
  }

  async putDerivedMaterialization(input: PutDerivedMaterializationInput): Promise<StoredViewMaterialization> {
    const ref = this.parseExactRef(input.view, "put_derived_materialization");
    const materialization = this.parseMaterialization(input.materialization, "put_derived_materialization");
    const updatedAt = TimestampSchema.safeParse(input.updated_at);
    if (!updatedAt.success || !Number.isInteger(input.expected_generation) || input.expected_generation < 0) {
      throw new ViewRepositoryError(
        "invalid derived Materialization commit",
        "invalid_request",
        { operation: "put_derived_materialization", view_ids: [ref.view_id] },
        { cause: updatedAt.success ? undefined : updatedAt.error },
      );
    }
    const transaction = this.transactionContext("put_derived_materialization", [ref.view_id]);
    return this.withTransaction(transaction, () => {
      transaction.phase = "validate_target";
      if (!this.exactViewExists(ref)) {
        throw this.problem(
          "referential_integrity",
          `View ${viewKey(ref)} does not exist`,
          transaction,
        );
      }
      const existing = this.db.prepare(`
        select view_id, revision, materialization_id, role, generation, updated_at, materialization_json
        from view_materializations_v1
        where view_id = ? and revision = ? and materialization_id = ?
      `).get(ref.view_id, ref.revision, materialization.id) as MaterializationRow | undefined;
      if (existing && existing.role !== "derived") {
        throw this.problem(
          "conflict",
          `Materialization ${materialization.id} is an immutable ${existing.role} manifest entry`,
          transaction,
        );
      }
      const currentGeneration = Number(existing?.generation ?? 0);
      if (input.expected_generation !== currentGeneration) {
        throw this.problem(
          "conflict",
          `Materialization generation conflict for ${viewKey(ref)}/${materialization.id}: expected ${input.expected_generation}, found ${currentGeneration}`,
          transaction,
        );
      }
      const generation = currentGeneration + 1;
      transaction.phase = "persist";
      this.db.prepare(`
        insert into view_materializations_v1 (
          view_id, revision, materialization_id, role, generation, updated_at, materialization_json
        ) values (?, ?, ?, 'derived', ?, ?, ?)
        on conflict(view_id, revision, materialization_id) do update set
          generation = excluded.generation,
          updated_at = excluded.updated_at,
          materialization_json = excluded.materialization_json
      `).run(
        ref.view_id,
        ref.revision,
        materialization.id,
        generation,
        updatedAt.data,
        JSON.stringify(materialization),
      );
      return {
        view: ref,
        role: "derived",
        materialization,
        generation,
        updated_at: updatedAt.data,
      };
    });
  }

  async traverseRelations(query: RelationTraversalQuery): Promise<ViewRelation[]> {
    const ref = this.parseExactRef(query.ref, "traverse_relations");
    return this.read("traverse_relations", () => {
      const direction = query.direction ?? "both";
      if (direction !== "incoming" && direction !== "outgoing" && direction !== "both") {
        throw invalidRequest("relation direction must be incoming, outgoing, or both", "traverse_relations");
      }
      if (query.type !== undefined && (typeof query.type !== "string" || !query.type.trim())) {
        throw invalidRequest("relation type must be a non-empty string", "traverse_relations");
      }
      if (!this.exactViewExists(ref)) {
        throw new ViewRepositoryError(
          `View ${viewKey(ref)} does not exist`,
          "referential_integrity",
          { operation: "traverse_relations", view_ids: [ref.view_id] },
        );
      }
      const limit = boundedLimit(query.limit, 100, 1_000, "traverse_relations");
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      if (direction === "outgoing") {
        clauses.push("source_view_id = ? and source_revision = ?");
        values.push(ref.view_id, ref.revision);
      } else if (direction === "incoming") {
        clauses.push("target_view_id = ? and target_revision = ?");
        values.push(ref.view_id, ref.revision);
      } else {
        clauses.push("((source_view_id = ? and source_revision = ?) or (target_view_id = ? and target_revision = ?))");
        values.push(ref.view_id, ref.revision, ref.view_id, ref.revision);
      }
      if (query.type) {
        clauses.push("type = ?");
        values.push(query.type);
      }
      const rows = this.db.prepare(`
        select id, type, source_view_id, source_revision, target_view_id, target_revision, created_at, metadata_json
        from view_relations_v1
        where ${clauses.join(" and ")}
        order by created_at asc, id asc
        limit ?
      `).all(...values, limit) as RelationRow[];
      return rows.map(row => this.parseRelationRow(row));
    });
  }

  async registerCaptureConnection(input: {
    connection: SourceConnection;
    manifest: ConnectorManifest;
    occurred_at: string;
  }): Promise<void> {
    const connection = SourceConnectionSchema.parse(input.connection);
    const manifest = ConnectorManifestSchema.parse(input.manifest);
    if (connection.connector_id !== manifest.id || connection.connector_version !== manifest.version) {
      throw new CaptureRuntimeError("Capture connection does not match the Connector manifest", "connector_mismatch", "validation", false);
    }
    const fingerprint = captureConnectionFingerprint(connection, manifest);
    const transaction = this.transactionContext("capture_register_connection", []);
    this.withTransaction(transaction, () => {
      const existing = this.readCaptureConnectionRow(connection.id);
      if (existing) {
        if (existing.connection_fingerprint !== fingerprint) {
          throw new CaptureRuntimeError(`Capture connection ${connection.id} was redefined`, "connection_conflict", "storage", false);
        }
        if (Number(existing.in_flight) > 0) {
          const currentHealth = this.parseCaptureHealth(existing.health_json, connection.id);
          const recovered = ConnectorHealthSchema.parse({
            ...currentHealth,
            status: "degraded",
            observed_at: input.occurred_at,
            consecutive_failures: currentHealth.consecutive_failures + 1,
            last_error: {
              code: "restart_recovery",
              message: "An incomplete Capture attempt was recovered after restart",
              stage: "runtime",
              retryable: true,
              details: {},
            },
          });
          this.db.prepare(`
            update capture_connections_v1 set in_flight = 0, health_json = ?, updated_at = ? where connection_id = ?
          `).run(JSON.stringify(recovered), input.occurred_at, connection.id);
          this.insertCaptureTrace({
            connection_id: connection.id,
            type: "connection.recovered",
            occurred_at: input.occurred_at,
            payload: { abandoned_attempts: Number(existing.in_flight) },
          });
        }
        return;
      }
      const checkpoint = CaptureCheckpointSchema.parse({
        connection_id: connection.id,
        revision: 0,
        cursor: {},
        updated_at: input.occurred_at,
      });
      const health = ConnectorHealthSchema.parse({
        connection_id: connection.id,
        status: "unknown",
        observed_at: input.occurred_at,
        consecutive_failures: 0,
        capabilities: manifest.capabilities,
      });
      this.db.prepare(`
        insert into capture_connections_v1 (
          connection_id, connector_id, connector_version, connection_fingerprint,
          connection_json, manifest_json, checkpoint_json, health_json, paused, in_flight, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)
      `).run(
        connection.id,
        connection.connector_id,
        connection.connector_version,
        fingerprint,
        JSON.stringify(connection),
        JSON.stringify(manifest),
        JSON.stringify(checkpoint),
        JSON.stringify(health),
        input.occurred_at,
      );
      this.insertCaptureTrace({
        connection_id: connection.id,
        type: "connection.registered",
        occurred_at: input.occurred_at,
        payload: { connector: { id: manifest.id, version: manifest.version } },
      });
    });
  }

  async getCaptureConnection(connectionId: string): Promise<SourceConnection | undefined> {
    const row = this.readCaptureConnectionRow(connectionId);
    return row ? SourceConnectionSchema.parse(parseJson(row.connection_json, "capture connection")) : undefined;
  }

  async getCaptureCheckpoint(connectionId: string): Promise<CaptureCheckpoint | undefined> {
    const row = this.readCaptureConnectionRow(connectionId);
    return row ? CaptureCheckpointSchema.parse(parseJson(row.checkpoint_json, "capture checkpoint")) : undefined;
  }

  async getCaptureHealth(connectionId: string): Promise<ConnectorHealth | undefined> {
    const row = this.readCaptureConnectionRow(connectionId);
    return row ? this.parseCaptureHealth(row.health_json, connectionId) : undefined;
  }

  async beginCaptureAttempt(input: {
    connection_id: string;
    batch: import("@info/capture").CaptureBatch;
    attempt: number;
    max_in_flight: number;
    occurred_at: string;
  }): Promise<void> {
    const batch = CaptureBatchSchema.parse(input.batch);
    const transaction = this.transactionContext("capture_begin_attempt", []);
    this.withTransaction(transaction, () => {
      const row = this.requireCaptureConnectionRow(input.connection_id);
      if (Number(row.paused) === 1) {
        throw new CaptureRuntimeError(`Capture connection ${input.connection_id} is paused`, "connection_paused", "runtime", false);
      }
      if (Number(row.in_flight) >= input.max_in_flight) {
        throw new CaptureRuntimeError(`Capture connection ${input.connection_id} reached its in-flight limit`, "backpressure", "runtime", true, {
          max_in_flight: input.max_in_flight,
        });
      }
      this.db.prepare(`
        update capture_connections_v1 set in_flight = in_flight + 1, updated_at = ? where connection_id = ?
      `).run(input.occurred_at, input.connection_id);
      this.insertCaptureTrace({
        connection_id: input.connection_id,
        batch_id: batch.id,
        attempt: input.attempt,
        type: "capture.attempt_started",
        occurred_at: input.occurred_at,
        payload: { delivery: batch.delivery, sequence: batch.sequence },
      });
    });
  }

  async commitCaptureBatch(input: CommitCaptureBatchInput): Promise<CommitCaptureBatchResult> {
    const connection = SourceConnectionSchema.parse(input.connection);
    const batch = CaptureBatchSchema.parse(input.batch);
    const checkpoint = CaptureCheckpointSchema.parse(input.checkpoint);
    const fingerprint = captureBatchFingerprint(batch);
    const transaction = this.transactionContext("capture_commit_batch", input.commits.map(item => item.commit.draft.id));
    return this.withTransaction(transaction, () => {
      const connectionRow = this.requireCaptureConnectionRow(connection.id);
      const replay = this.db.prepare(`
        select request_fingerprint, result_json from capture_batches_v1 where idempotency_key = ?
      `).get(batch.idempotency_key) as CaptureBatchRow | undefined;
      if (replay) {
        if (replay.request_fingerprint !== fingerprint) {
          throw new CaptureRuntimeError(`Capture Batch idempotency key ${batch.idempotency_key} was reused`, "idempotency_conflict", "admission", false);
        }
        const result = parseJson(replay.result_json, "Capture Batch result") as CommitCaptureBatchResult;
        const forgottenReceipt = result.receipts.find(receipt => (
          receipt.status === "stored" && this.isForgottenViewIdentity(receipt.view_id)
        ));
        if (forgottenReceipt?.status === "stored") {
          transaction.phase = "reject_forgotten_capture_replay";
          throw this.problem(
            "policy_violation",
            `Capture Batch ${batch.id} references permanently retired View identity ${forgottenReceipt.view_id}`,
            transaction,
            { idempotency_key: batch.idempotency_key },
          );
        }
        this.db.prepare(`update capture_connections_v1 set in_flight = max(0, in_flight - 1), updated_at = ? where connection_id = ?`)
          .run(input.completed_at, connection.id);
        this.insertCaptureTrace({
          connection_id: connection.id,
          batch_id: batch.id,
          attempt: input.attempt,
          type: "capture.batch_replayed",
          occurred_at: input.completed_at,
          payload: { idempotency_key: batch.idempotency_key },
        });
        return { ...result, replayed: true, transaction_id: transaction.id };
      }

      const currentCheckpoint = CaptureCheckpointSchema.parse(parseJson(connectionRow.checkpoint_json, "capture checkpoint"));
      const transition = batch.checkpoint;
      if (!transition || transition.expected_revision !== currentCheckpoint.revision
        || canonicalJson(transition.previous) !== canonicalJson(currentCheckpoint.cursor)
        || checkpoint.revision !== currentCheckpoint.revision + 1
        || canonicalJson(checkpoint.cursor) !== canonicalJson(transition.next)) {
        throw new CaptureRuntimeError(`Capture Batch ${batch.id} has a stale checkpoint transition`, "checkpoint_conflict", "checkpoint", false, {
          current_revision: currentCheckpoint.revision,
        });
      }

      const normalized = input.commits.length > 0
        ? this.normalizeCommits(input.commits.map(item => item.commit))
        : [];
      const plans = normalized.length > 0 ? this.planCommits(normalized, transaction) : [];
      if (plans.length > 0) this.validatePlannedReferences(plans, transaction);
      for (const plan of plans) if (plan.created) this.persistPlan(plan, transaction);
      transaction.phase = "persist_view_committed_event";
      this.persistViewCommittedEvent(plans, transaction, {
        batch_id: batch.id,
        committed_at: input.completed_at,
        origin: { kind: "capture", id: connection.id },
      });

      const receipts: CommitCaptureBatchResult["receipts"] = new Array(batch.candidates.length);
      input.skipped.forEach(item => { receipts[item.candidate_index] = item.receipt; });
      input.commits.forEach((item, index) => {
        const plan = plans[index];
        if (!plan) throw new ViewRepositoryError("Capture commit plan is incomplete", "corrupt_data", { operation: transaction.operation, phase: "build_receipts" });
        receipts[item.candidate_index] = {
          status: "stored",
          view_id: plan.view.id,
          revision: plan.view.revision,
          created: plan.created,
        };
      });
      if (receipts.some(receipt => receipt === undefined)) {
        throw new ViewRepositoryError("Capture Batch did not produce one receipt per candidate", "corrupt_data", { operation: transaction.operation, phase: "build_receipts" });
      }
      const health = ConnectorHealthSchema.parse({
        connection_id: connection.id,
        status: "healthy",
        observed_at: input.completed_at,
        consecutive_failures: 0,
        capabilities: this.parseCaptureHealth(connectionRow.health_json, connection.id).capabilities,
        last_success_at: input.completed_at,
      });
      const result: CommitCaptureBatchResult = {
        receipts,
        checkpoint,
        replayed: false,
        transaction_id: transaction.id,
      };
      this.db.prepare(`
        update capture_connections_v1
        set checkpoint_json = ?, health_json = ?, in_flight = max(0, in_flight - 1), updated_at = ?
        where connection_id = ?
      `).run(JSON.stringify(checkpoint), JSON.stringify(health), input.completed_at, connection.id);
      this.db.prepare(`
        insert into capture_batches_v1 (
          idempotency_key, request_fingerprint, batch_id, connection_id, result_json, created_at
        ) values (?, ?, ?, ?, ?, ?)
      `).run(batch.idempotency_key, fingerprint, batch.id, connection.id, JSON.stringify(result), input.completed_at);
      this.insertCaptureTrace({
        connection_id: connection.id,
        batch_id: batch.id,
        attempt: input.attempt,
        type: "capture.batch_committed",
        occurred_at: input.completed_at,
        payload: {
          receipt_count: receipts.length,
          stored_count: receipts.filter(receipt => receipt.status === "stored").length,
          skipped_count: receipts.filter(receipt => receipt.status === "skipped").length,
          checkpoint_revision: checkpoint.revision,
          transaction_id: transaction.id,
        },
      });
      return result;
    });
  }

  async failCaptureAttempt(input: {
    connection_id: string;
    batch: import("@info/capture").CaptureBatch;
    attempt: number;
    error: import("@info/capture").CaptureSafeError;
    occurred_at: string;
    dead_letter?: CaptureDeadLetter;
  }): Promise<void> {
    const batch = CaptureBatchSchema.parse(input.batch);
    const error = importCaptureSafeError(input.error);
    const deadLetter = input.dead_letter ? CaptureDeadLetterSchema.parse(input.dead_letter) : undefined;
    const transaction = this.transactionContext("capture_fail_attempt", []);
    this.withTransaction(transaction, () => {
      const row = this.requireCaptureConnectionRow(input.connection_id);
      const current = this.parseCaptureHealth(row.health_json, input.connection_id);
      const failures = current.consecutive_failures + 1;
      const health = ConnectorHealthSchema.parse({
        connection_id: input.connection_id,
        status: deadLetter ? "unhealthy" : "degraded",
        observed_at: input.occurred_at,
        consecutive_failures: failures,
        capabilities: current.capabilities,
        ...(current.last_success_at ? { last_success_at: current.last_success_at } : {}),
        last_error: error,
      });
      this.db.prepare(`
        update capture_connections_v1 set health_json = ?, in_flight = max(0, in_flight - 1), updated_at = ? where connection_id = ?
      `).run(JSON.stringify(health), input.occurred_at, input.connection_id);
      this.insertCaptureTrace({
        connection_id: input.connection_id,
        batch_id: batch.id,
        attempt: input.attempt,
        type: "capture.attempt_failed",
        occurred_at: input.occurred_at,
        payload: {},
        error,
      });
      if (deadLetter) {
        const existing = this.db.prepare(`select dead_letter_json from capture_dead_letters_v1 where id = ?`)
          .get(deadLetter.id) as CaptureDeadLetterRow | undefined;
        if (existing && canonicalJson(parseJson(existing.dead_letter_json, "capture dead letter") as never) !== canonicalJson(deadLetter as never)) {
          throw new CaptureRuntimeError(`Dead letter ${deadLetter.id} conflicts with stored evidence`, "dead_letter_conflict", "storage", false);
        }
        if (!existing) {
          this.db.prepare(`
            insert into capture_dead_letters_v1 (id, connection_id, status, created_at, dead_letter_json)
            values (?, ?, ?, ?, ?)
          `).run(deadLetter.id, deadLetter.connection_id, deadLetter.status, deadLetter.created_at, JSON.stringify(deadLetter));
        }
        this.insertCaptureTrace({
          connection_id: input.connection_id,
          batch_id: batch.id,
          attempt: input.attempt,
          type: "capture.dead_lettered",
          occurred_at: input.occurred_at,
          payload: { dead_letter_id: deadLetter.id },
          error,
        });
      }
    });
  }

  async appendCaptureTrace(event: import("@info/capture").CaptureTraceEvent): Promise<StoredCaptureTraceEvent> {
    const transaction = this.transactionContext("capture_append_trace", []);
    return this.withTransaction(transaction, () => {
      this.requireCaptureConnectionRow(event.connection_id);
      return this.insertCaptureTrace(event);
    });
  }

  async getCaptureTrace(connectionId: string): Promise<StoredCaptureTraceEvent[]> {
    const rows = this.db.prepare(`select sequence, event_json from capture_trace_v1 where connection_id = ? order by sequence`)
      .all(connectionId) as CaptureTraceRow[];
    return rows.map(row => ({
      ...CaptureTraceEventSchema.parse(parseJson(row.event_json, "capture trace event")),
      sequence: Number(row.sequence),
    }));
  }

  async setCapturePaused(input: { connection_id: string; paused: boolean; occurred_at: string }): Promise<void> {
    const transaction = this.transactionContext("capture_set_paused", []);
    this.withTransaction(transaction, () => {
      const row = this.requireCaptureConnectionRow(input.connection_id);
      if (Number(row.in_flight) > 0) throw new CaptureRuntimeError("Cannot pause a connection with an active Capture attempt", "backpressure", "runtime", true);
      const current = this.parseCaptureHealth(row.health_json, input.connection_id);
      const health = ConnectorHealthSchema.parse({
        ...current,
        status: input.paused ? "paused" : "unknown",
        observed_at: input.occurred_at,
      });
      this.db.prepare(`update capture_connections_v1 set paused = ?, health_json = ?, updated_at = ? where connection_id = ?`)
        .run(input.paused ? 1 : 0, JSON.stringify(health), input.occurred_at, input.connection_id);
      this.insertCaptureTrace({
        connection_id: input.connection_id,
        type: input.paused ? "connection.paused" : "connection.resumed",
        occurred_at: input.occurred_at,
        payload: {},
      });
    });
  }

  async recordCaptureHealth(input: { health: ConnectorHealth; event: import("@info/capture").CaptureTraceEvent }): Promise<void> {
    const health = ConnectorHealthSchema.parse(input.health);
    const event = CaptureTraceEventSchema.parse(input.event);
    const transaction = this.transactionContext("capture_record_health", []);
    this.withTransaction(transaction, () => {
      this.requireCaptureConnectionRow(health.connection_id);
      this.db.prepare(`update capture_connections_v1 set health_json = ?, updated_at = ? where connection_id = ?`)
        .run(JSON.stringify(health), health.observed_at, health.connection_id);
      this.insertCaptureTrace(event);
    });
  }

  async listCaptureDeadLetters(connectionId: string, status?: CaptureDeadLetter["status"]): Promise<CaptureDeadLetter[]> {
    const rows = status
      ? this.db.prepare(`select dead_letter_json from capture_dead_letters_v1 where connection_id = ? and status = ? order by created_at`)
          .all(connectionId, status) as CaptureDeadLetterRow[]
      : this.db.prepare(`select dead_letter_json from capture_dead_letters_v1 where connection_id = ? order by created_at`)
          .all(connectionId) as CaptureDeadLetterRow[];
    return rows.map(row => CaptureDeadLetterSchema.parse(parseJson(row.dead_letter_json, "capture dead letter")));
  }

  async getCaptureDeadLetter(id: string): Promise<CaptureDeadLetter | undefined> {
    const row = this.db.prepare(`select dead_letter_json from capture_dead_letters_v1 where id = ?`).get(id) as CaptureDeadLetterRow | undefined;
    return row ? CaptureDeadLetterSchema.parse(parseJson(row.dead_letter_json, "capture dead letter")) : undefined;
  }

  async resolveCaptureDeadLetter(input: { id: string; resolved_at: string }): Promise<CaptureDeadLetter> {
    const transaction = this.transactionContext("capture_resolve_dead_letter", []);
    return this.withTransaction(transaction, () => {
      const current = this.db.prepare(`select dead_letter_json from capture_dead_letters_v1 where id = ?`).get(input.id) as CaptureDeadLetterRow | undefined;
      if (!current) throw new CaptureRuntimeError(`Dead letter ${input.id} does not exist`, "dead_letter_not_found", "storage", false);
      const parsed = CaptureDeadLetterSchema.parse(parseJson(current.dead_letter_json, "capture dead letter"));
      const resolved = CaptureDeadLetterSchema.parse({ ...parsed, status: "resolved", resolved_at: input.resolved_at });
      this.db.prepare(`update capture_dead_letters_v1 set status = 'resolved', dead_letter_json = ? where id = ?`)
        .run(JSON.stringify(resolved), input.id);
      return resolved;
    });
  }

  private readCaptureConnectionRow(connectionId: string): CaptureConnectionRow | undefined {
    return this.db.prepare(`
      select connection_json, manifest_json, connection_fingerprint, checkpoint_json, health_json, paused, in_flight
      from capture_connections_v1 where connection_id = ?
    `).get(connectionId) as CaptureConnectionRow | undefined;
  }

  private requireCaptureConnectionRow(connectionId: string): CaptureConnectionRow {
    const row = this.readCaptureConnectionRow(connectionId);
    if (!row) throw new CaptureRuntimeError(`Capture connection ${connectionId} does not exist`, "connection_not_found", "storage", false);
    return row;
  }

  private parseCaptureHealth(value: string, connectionId: string): ConnectorHealth {
    try {
      return ConnectorHealthSchema.parse(parseJson(value, "capture health"));
    } catch (error) {
      throw new ViewRepositoryError(
        `Capture health for ${connectionId} is corrupt`,
        "corrupt_data",
        { operation: "capture_read_health", table: "capture_connections_v1" },
        { cause: error },
      );
    }
  }

  private insertCaptureTrace(input: import("@info/capture").CaptureTraceEvent): StoredCaptureTraceEvent {
    const event = CaptureTraceEventSchema.parse(input);
    if (event.sequence !== undefined) {
      throw new CaptureRuntimeError("Capture trace sequence is assigned by the repository", "capture_trace_invalid", "storage", false);
    }
    const result = this.db.prepare(`
      insert into capture_trace_v1 (connection_id, batch_id, type, occurred_at, event_json)
      values (?, ?, ?, ?, ?)
    `).run(event.connection_id, event.batch_id ?? null, event.type, event.occurred_at, JSON.stringify(event));
    return { ...event, sequence: Number(result.lastInsertRowid) };
  }

  async leaseEvents(inputValue: LeaseViewCommittedEventsInput): Promise<ViewCommittedOutboxEntry[]> {
    const input = this.parseOutboxInput(LeaseViewCommittedEventsInputSchema, inputValue, "view_commit_outbox_lease");
    const leasedAt = normalizeTimestamp(input.leased_at);
    const leaseExpiresAt = new Date(Date.parse(leasedAt) + input.lease_duration_ms).toISOString();
    const transaction = this.transactionContext("view_commit_outbox_lease", []);
    return this.withTransaction(transaction, () => {
      transaction.phase = "select_available_events";
      const rows = this.db.prepare(`
        select sequence, event_id, status, delivery_attempts, available_at,
               leased_by, lease_expires_at, acknowledged_at, poisoned_at,
               last_error_json, event_json
        from view_commit_outbox_v1
        where (status = 'pending' and available_at <= ?)
           or (status = 'leased' and lease_expires_at <= ?)
        order by sequence
        limit ?
      `).all(leasedAt, leasedAt, input.limit) as ViewCommitOutboxRow[];

      const leased: ViewCommittedOutboxEntry[] = [];
      for (const row of rows) {
        const event = this.parseOutboxEvent(row);
        transaction.phase = "validate_publishable_refs";
        this.assertOutboxEventPublishable(event, transaction);
        transaction.phase = "persist_lease";
        const updated = this.db.prepare(`
          update view_commit_outbox_v1
          set status = 'leased', delivery_attempts = delivery_attempts + 1,
              leased_by = ?, lease_expires_at = ?, acknowledged_at = null,
              poisoned_at = null
          where event_id = ?
        `).run(input.consumer_id, leaseExpiresAt, event.event_id);
        if (Number(updated.changes) !== 1) {
          throw this.outboxProblem("storage_failure", `Outbox event ${event.event_id} disappeared while leasing`, {
            operation: transaction.operation,
            event_id: event.event_id,
            consumer_id: input.consumer_id,
            sequence: Number(row.sequence),
          });
        }
        leased.push(this.mustReadOutboxEntry(event.event_id));
      }
      return leased;
    });
  }

  async acknowledgeEvent(inputValue: AcknowledgeViewCommittedEventInput): Promise<ViewCommittedOutboxEntry> {
    const input = this.parseOutboxInput(AcknowledgeViewCommittedEventInputSchema, inputValue, "view_commit_outbox_acknowledge");
    const acknowledgedAt = normalizeTimestamp(input.acknowledged_at);
    const transaction = this.transactionContext("view_commit_outbox_acknowledge", []);
    return this.withTransaction(transaction, () => {
      const current = this.mustReadOutboxEntry(input.event_id);
      if (current.status === "acknowledged") return current;
      this.assertActiveOutboxLease(current, input.consumer_id, acknowledgedAt, transaction.operation);
      transaction.phase = "persist_acknowledgement";
      this.db.prepare(`
        update view_commit_outbox_v1
        set status = 'acknowledged', acknowledged_at = ?, leased_by = null,
            lease_expires_at = null, poisoned_at = null, last_error_json = null
        where event_id = ?
      `).run(acknowledgedAt, input.event_id);
      return this.mustReadOutboxEntry(input.event_id);
    });
  }

  async failEvent(inputValue: FailViewCommittedEventInput): Promise<ViewCommittedOutboxEntry> {
    const input = this.parseOutboxInput(FailViewCommittedEventInputSchema, inputValue, "view_commit_outbox_fail");
    const failedAt = normalizeTimestamp(input.failed_at);
    const retryAt = input.retry_at ? normalizeTimestamp(input.retry_at) : undefined;
    if (retryAt && Date.parse(retryAt) < Date.parse(failedAt)) {
      throw this.outboxProblem("invalid_request", "retry_at cannot precede failed_at", {
        operation: "view_commit_outbox_fail",
        event_id: input.event_id,
        consumer_id: input.consumer_id,
      });
    }
    const transaction = this.transactionContext("view_commit_outbox_fail", []);
    return this.withTransaction(transaction, () => {
      const current = this.mustReadOutboxEntry(input.event_id);
      this.assertActiveOutboxLease(current, input.consumer_id, failedAt, transaction.operation);
      transaction.phase = retryAt ? "persist_retry" : "persist_poison";
      this.db.prepare(`
        update view_commit_outbox_v1
        set status = ?, available_at = ?, leased_by = null, lease_expires_at = null,
            acknowledged_at = null, poisoned_at = ?, last_error_json = ?
        where event_id = ?
      `).run(
        retryAt ? "pending" : "poison",
        retryAt ?? failedAt,
        retryAt ? null : failedAt,
        JSON.stringify(input.failure),
        input.event_id,
      );
      return this.mustReadOutboxEntry(input.event_id);
    });
  }

  async replayEvent(inputValue: ReplayViewCommittedEventInput): Promise<ViewCommittedOutboxEntry> {
    const input = this.parseOutboxInput(ReplayViewCommittedEventInputSchema, inputValue, "view_commit_outbox_replay");
    const requestedAt = normalizeTimestamp(input.requested_at);
    const transaction = this.transactionContext("view_commit_outbox_replay", []);
    return this.withTransaction(transaction, () => {
      const current = this.mustReadOutboxEntry(input.event_id);
      if (current.status === "leased") {
        throw this.outboxProblem("lease_conflict", `Outbox event ${input.event_id} has an active lease`, {
          operation: transaction.operation,
          event_id: input.event_id,
          consumer_id: current.leased_by,
          sequence: current.sequence,
        });
      }
      transaction.phase = "validate_publishable_refs";
      this.assertOutboxEventPublishable(current.event, transaction);
      transaction.phase = "persist_replay";
      this.db.prepare(`
        update view_commit_outbox_v1
        set status = 'pending', available_at = ?, leased_by = null,
            lease_expires_at = null, acknowledged_at = null,
            poisoned_at = null, last_error_json = null
        where event_id = ?
      `).run(requestedAt, input.event_id);
      return this.mustReadOutboxEntry(input.event_id);
    });
  }

  async getEvent(eventIdValue: string): Promise<ViewCommittedOutboxEntry | undefined> {
    const eventId = this.parseOutboxInput(IdentifierSchema, eventIdValue, "view_commit_outbox_get");
    return this.readOutbox("view_commit_outbox_get", () => {
      const row = this.readOutboxRow(eventId);
      return row ? this.parseOutboxRow(row) : undefined;
    });
  }

  async listEvents(inputValue: ListViewCommittedEventsInput = {}): Promise<ViewCommittedOutboxEntry[]> {
    const input = this.parseOutboxInput(ListViewCommittedEventsInputSchema, inputValue, "view_commit_outbox_list");
    return this.readOutbox("view_commit_outbox_list", () => {
      const params: Array<string | number> = [];
      const where = input.statuses
        ? `where status in (${sqlPlaceholders(input.statuses.length)})`
        : "";
      if (input.statuses) params.push(...input.statuses);
      params.push(input.limit);
      const rows = this.db.prepare(`
        select sequence, event_id, status, delivery_attempts, available_at,
               leased_by, lease_expires_at, acknowledged_at, poisoned_at,
               last_error_json, event_json
        from view_commit_outbox_v1
        ${where}
        order by sequence
        limit ?
      `).all(...params) as ViewCommitOutboxRow[];
      return rows.map(row => this.parseOutboxRow(row));
    });
  }

  private persistViewCommittedEvent(
    plans: PlannedCommit[],
    transaction: TransactionContext,
    contextValue?: ViewCommitContext,
  ): ViewCommittedEvent | undefined {
    const created = plans.filter(plan => plan.created).map(plan => plan.view);
    if (created.length === 0) return undefined;
    let context: ViewCommitContext;
    try {
      context = ViewCommitContextSchema.parse(contextValue ?? {
        origin: { kind: "system", id: "view-repository" },
      });
    } catch (error) {
      throw this.problem(
        "invalid_request",
        "View commit context is invalid",
        transaction,
        {},
        error,
      );
    }
    const committedAt = normalizeTimestamp(context.committed_at ?? this.now());
    const event = parseViewCommittedEvent({
      event_id: IdentifierSchema.parse(this.eventIdFactory(transaction.id)),
      event_type: "view.committed",
      event_version: 1,
      batch_id: context.batch_id ?? `view-batch:${transaction.id}`,
      transaction_id: transaction.id,
      committed_at: committedAt,
      origin: context.origin,
      ...(context.cascade ? { cascade: context.cascade } : {}),
      views: created.map(view => ({
        ref: exactViewRef(view),
        role: view.role,
        schema: {
          name: view.schema.name,
          version: view.schema.version,
          mode: view.schema.mode,
        },
        retention: view.policy.retention,
      })),
    });
    const inserted = this.db.prepare(`
      insert into view_commit_outbox_v1 (
        event_id, batch_id, transaction_id, status, delivery_attempts,
        available_at, created_at, event_json
      ) values (?, ?, ?, 'pending', 0, ?, ?, ?)
    `).run(
      event.event_id,
      event.batch_id,
      event.transaction_id,
      committedAt,
      committedAt,
      JSON.stringify(event),
    );
    const sequence = Number(inserted.lastInsertRowid);
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw this.outboxProblem("storage_failure", "SQLite did not assign an outbox sequence", {
        operation: transaction.operation,
        event_id: event.event_id,
      });
    }
    const insertRef = this.db.prepare(`
      insert into view_commit_outbox_refs_v1 (event_id, view_id, revision)
      values (?, ?, ?)
    `);
    for (const summary of event.views) {
      insertRef.run(event.event_id, summary.ref.view_id, summary.ref.revision);
    }
    return event;
  }

  private readOutboxRow(eventId: string): ViewCommitOutboxRow | undefined {
    return this.db.prepare(`
      select sequence, event_id, status, delivery_attempts, available_at,
             leased_by, lease_expires_at, acknowledged_at, poisoned_at,
             last_error_json, event_json
      from view_commit_outbox_v1
      where event_id = ?
    `).get(eventId) as ViewCommitOutboxRow | undefined;
  }

  private mustReadOutboxEntry(eventId: string): ViewCommittedOutboxEntry {
    const row = this.readOutboxRow(eventId);
    if (!row) {
      throw this.outboxProblem("not_found", `Outbox event ${eventId} does not exist`, {
        operation: "view_commit_outbox_read",
        event_id: eventId,
      });
    }
    return this.parseOutboxRow(row);
  }

  private parseOutboxEvent(row: ViewCommitOutboxRow): ViewCommittedEvent {
    try {
      const event = parseViewCommittedEvent(JSON.parse(row.event_json));
      if (event.event_id !== row.event_id) {
        throw new Error(`normalized event id ${row.event_id} diverges from event payload ${event.event_id}`);
      }
      return event;
    } catch (error) {
      if (error instanceof ViewCommittedOutboxError) throw error;
      throw this.outboxProblem(
        "corrupt_event",
        `Stored outbox event ${row.event_id} failed validation`,
        { operation: "view_commit_outbox_parse", event_id: row.event_id, sequence: Number(row.sequence) },
        error,
      );
    }
  }

  private parseOutboxRow(row: ViewCommitOutboxRow): ViewCommittedOutboxEntry {
    try {
      const event = this.parseOutboxEvent(row);
      const expectedRefs = event.views.map(item => viewKey(item.ref)).sort();
      const linkedRefs = (this.db.prepare(`
        select view_id, revision from view_commit_outbox_refs_v1
        where event_id = ? order by view_id, revision
      `).all(event.event_id) as Array<{ view_id: string; revision: number }>)
        .map(item => `${item.view_id}@${Number(item.revision)}`)
        .sort();
      if (canonicalJson(expectedRefs) !== canonicalJson(linkedRefs)) {
        throw new Error("outbox exact-ref index diverges from the immutable event payload");
      }
      return ViewCommittedOutboxEntrySchema.parse({
        sequence: Number(row.sequence),
        event,
        status: row.status,
        delivery_attempts: Number(row.delivery_attempts),
        available_at: row.available_at,
        ...(row.leased_by ? { leased_by: row.leased_by } : {}),
        ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
        ...(row.acknowledged_at ? { acknowledged_at: row.acknowledged_at } : {}),
        ...(row.poisoned_at ? { poisoned_at: row.poisoned_at } : {}),
        ...(row.last_error_json ? { last_error: JSON.parse(row.last_error_json) } : {}),
      });
    } catch (error) {
      if (error instanceof ViewCommittedOutboxError) throw error;
      throw this.outboxProblem(
        "corrupt_event",
        `Stored outbox state for ${row.event_id} failed validation`,
        { operation: "view_commit_outbox_parse", event_id: row.event_id, sequence: Number(row.sequence) },
        error,
      );
    }
  }

  private assertOutboxEventPublishable(event: ViewCommittedEvent, transaction: TransactionContext): void {
    for (const item of event.views) {
      if (this.isForgottenViewIdentity(item.ref.view_id) || !this.exactViewExists(item.ref)) {
        throw this.outboxProblem(
          "replay_forbidden",
          `Outbox event ${event.event_id} references unavailable View ${viewKey(item.ref)}`,
          { operation: transaction.operation, event_id: event.event_id },
        );
      }
    }
  }

  private assertActiveOutboxLease(
    entry: ViewCommittedOutboxEntry,
    consumerId: string,
    occurredAt: string,
    operation: string,
  ): void {
    const active = entry.status === "leased"
      && entry.leased_by === consumerId
      && entry.lease_expires_at !== undefined
      && Date.parse(occurredAt) < Date.parse(entry.lease_expires_at);
    if (active) return;
    throw this.outboxProblem(
      "lease_conflict",
      `Outbox event ${entry.event.event_id} is not actively leased by ${consumerId}`,
      {
        operation,
        event_id: entry.event.event_id,
        consumer_id: consumerId,
        sequence: entry.sequence,
      },
    );
  }

  private readOutbox<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ViewCommittedOutboxError) throw error;
      throw this.outboxProblem("storage_failure", `SQLite View commit outbox ${operation} failed`, { operation }, error);
    }
  }

  private parseOutboxInput<T>(schema: { parse(value: unknown): T }, value: unknown, operation: string): T {
    try {
      return schema.parse(value);
    } catch (error) {
      throw this.outboxProblem("invalid_request", `Invalid input for ${operation}`, { operation }, error);
    }
  }

  private outboxProblem(
    code: import("@info/view").ViewCommittedOutboxErrorCode,
    message: string,
    details: ConstructorParameters<typeof ViewCommittedOutboxError>[2],
    cause?: unknown,
  ): ViewCommittedOutboxError {
    return new ViewCommittedOutboxError(
      message,
      code,
      details,
      cause === undefined ? undefined : { cause },
    );
  }

  close(): void {
    this.db.close();
  }

  private normalizeCommits(inputs: CommitViewInput[]): NormalizedCommit[] {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ViewRepositoryError(
        "View commit batch must contain at least one commit",
        "invalid_request",
        { operation: "commit_batch", phase: "validate_input" },
      );
    }
    return inputs.map((input, index) => {
      if (!Number.isInteger(input.expected_revision) || input.expected_revision < 0) {
        throw new ViewRepositoryError(
          `View commit ${index} requires a non-negative expected_revision`,
          "invalid_request",
          { operation: "commit_batch", phase: "validate_input" },
        );
      }
      let draft: ViewDraft;
      try {
        draft = parseViewDraft(input.draft);
      } catch (error) {
        throw new ViewRepositoryError(
          `View commit ${index} has an invalid draft`,
          "invalid_request",
          { operation: "commit_batch", phase: "validate_input" },
          { cause: error },
        );
      }
      if (draft.policy.retention === "do_not_store" || draft.policy.retention === "session") {
        throw new ViewRepositoryError(
          `SQLite View Store cannot persist ${draft.policy.retention} retention`,
          "policy_violation",
          { operation: "commit_batch", phase: "validate_input", view_ids: [draft.id] },
        );
      }
      const expectedRevision = input.expected_revision;
      const idempotencyKey = input.idempotency_key?.trim();
      if (input.idempotency_key !== undefined && !idempotencyKey) {
        throw new ViewRepositoryError(
          `View commit ${index} has an empty idempotency_key`,
          "invalid_request",
          { operation: "commit_batch", phase: "validate_input", view_ids: [draft.id] },
        );
      }
      return {
        draft,
        expectedRevision,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        fingerprint: commitFingerprint(draft, expectedRevision),
      };
    });
  }

  private planCommits(inputs: NormalizedCommit[], transaction: TransactionContext): PlannedCommit[] {
    const virtualHeads = new Map<string, View>();
    const batchIdempotency = new Map<string, PlannedCommit>();
    const batchCaptureIdentities = new Map<string, string>();
    const plans: PlannedCommit[] = [];
    for (const normalized of inputs) {
      if (this.isForgottenViewIdentity(normalized.draft.id)) {
        transaction.phase = "reject_forgotten_identity";
        throw this.problem(
          "policy_violation",
          `View identity ${normalized.draft.id} was permanently retired by Privacy Forget and cannot be reused`,
          transaction,
          { idempotency_key: normalized.idempotencyKey },
        );
      }
      const key = normalized.idempotencyKey;
      if (key) {
        const sameBatch = batchIdempotency.get(key);
        if (sameBatch) {
          this.assertIdempotencyMatch(key, sameBatch.normalized.fingerprint, normalized.fingerprint, transaction);
          plans.push({ normalized, view: sameBatch.view, created: false });
          continue;
        }
        const persisted = this.readIdempotency(key);
        if (persisted) {
          this.assertIdempotencyMatch(key, persisted.request_fingerprint, normalized.fingerprint, transaction);
          const view = this.mustReadStoredView(persisted.view_id, Number(persisted.revision));
          const replay = { normalized, view, created: false };
          plans.push(replay);
          batchIdempotency.set(key, replay);
          continue;
        }
      }

      const capture = normalized.draft.provenance.capture;
      if (capture) {
        const identityKey = captureIdentityKey(capture);
        const mappedViewId = batchCaptureIdentities.get(identityKey) ?? this.readCaptureIdentity(capture)?.view_id;
        if (mappedViewId && mappedViewId !== normalized.draft.id) {
          throw this.problem(
            "source_identity_conflict",
            `Captured source ${identityKey} is already bound to View ${mappedViewId}, not ${normalized.draft.id}`,
            transaction,
            { idempotency_key: key },
          );
        }
        batchCaptureIdentities.set(identityKey, normalized.draft.id);
      }

      const current = virtualHeads.get(normalized.draft.id) ?? this.tryReadLatestView(normalized.draft.id);
      const currentRevision = current?.revision ?? 0;
      if (normalized.expectedRevision !== currentRevision) {
        throw this.problem(
          "conflict",
          `View revision conflict for ${normalized.draft.id}: expected ${normalized.expectedRevision}, found ${currentRevision}`,
          transaction,
          { idempotency_key: key },
        );
      }
      if (current) {
        try {
          assertViewRevisionTransition(current, normalized.draft);
        } catch (error) {
          if (!(error instanceof ViewRevisionTransitionError)) throw error;
          throw this.problem("conflict", error.message, transaction, { idempotency_key: key }, error);
        }
      }
      const view = parseView({ ...normalized.draft, revision: currentRevision + 1 });
      const plan = { normalized, view, created: true };
      plans.push(plan);
      virtualHeads.set(view.id, view);
      if (key) batchIdempotency.set(key, plan);
    }
    return plans;
  }

  private validatePlannedReferences(plans: PlannedCommit[], transaction: TransactionContext): void {
    const plannedViews = new Map<string, View>();
    for (const plan of plans) {
      if (plan.created) plannedViews.set(viewKey(exactViewRef(plan.view)), plan.view);
    }
    for (const plan of plans) {
      if (!plan.created) continue;
      const ref = exactViewRef(plan.view);
      const forks = plan.view.relations.filter(relation => relation.type === "forked_from");
      const supersedes = plan.view.relations.filter(relation => relation.type === "supersedes");
      if (plan.view.revision === 1 && supersedes.length > 0) {
        throw this.problem("conflict", `Initial View ${plan.view.id} cannot supersede another revision`, transaction);
      }
      if (plan.view.revision > 1 && forks.length > 0) {
        throw this.problem("conflict", `Revision ${viewKey(ref)} cannot also declare forked_from`, transaction);
      }
      if (forks.length > 1) {
        throw this.problem("conflict", `View ${plan.view.id} can fork from only one exact revision`, transaction);
      }
      const relationIds = plan.view.relations.map(relation => relationId(ref, relation.type, relation.target, relation.metadata));
      if (new Set(relationIds).size !== relationIds.length) {
        throw this.problem("invalid_request", `View ${viewKey(ref)} contains duplicate exact relations`, transaction);
      }
      for (const input of plan.view.provenance.inputs) {
        this.assertExactReference(input, plannedViews, transaction, "provenance input");
      }
      for (const relation of plan.view.relations) {
        this.assertExactReference(relation.target, plannedViews, transaction, `relation ${relation.type}`);
      }
      if (forks[0]) {
        const base = this.resolveExactView(forks[0].target, plannedViews);
        if (!base) {
          throw this.problem(
            "referential_integrity",
            `Fork base ${viewKey(forks[0].target)} does not exist`,
            transaction,
          );
        }
        try {
          assertViewRevisionTransition(base, plan.normalized.draft);
        } catch (error) {
          if (!(error instanceof ViewRevisionTransitionError)) throw error;
          throw this.problem("conflict", error.message, transaction, {}, error);
        }
      }
    }
  }

  private persistPlan(plan: PlannedCommit, transaction: TransactionContext): void {
    const view = plan.view;
    this.db.prepare(`
      insert into view_revisions_v1 (
        id, revision, schema_name, schema_version, role, name, created_at, view_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      view.id,
      view.revision,
      view.schema.name,
      view.schema.version,
      view.role,
      view.name,
      view.time.created_at,
      JSON.stringify(view),
    );

    if (view.revision === 1) {
      this.db.prepare(`
        insert into view_heads_v1 (id, revision, updated_at) values (?, ?, ?)
      `).run(view.id, view.revision, view.time.created_at);
    } else {
      const changed = this.db.prepare(`
        update view_heads_v1 set revision = ?, updated_at = ? where id = ? and revision = ?
      `).run(view.revision, view.time.created_at, view.id, view.revision - 1);
      if (Number(changed.changes) !== 1) {
        throw this.problem(
          "conflict",
          `Atomic head update failed for ${view.id}@${view.revision}`,
          transaction,
        );
      }
    }

    if (plan.normalized.idempotencyKey) {
      this.db.prepare(`
        insert into view_idempotency_v1 (
          idempotency_key, request_fingerprint, view_id, revision, created_at
        ) values (?, ?, ?, ?, ?)
      `).run(
        plan.normalized.idempotencyKey,
        plan.normalized.fingerprint,
        view.id,
        view.revision,
        view.time.created_at,
      );
    }

    if (view.revision === 1 && view.provenance.capture) {
      const capture = view.provenance.capture;
      this.db.prepare(`
        insert into view_capture_identities_v1 (
          connector, connection_id, source_id, source_kind, identity, view_id, first_revision
        ) values (?, ?, ?, ?, ?, ?, ?)
      `).run(
        capture.connector,
        capture.connection_id,
        capture.source_id,
        capture.source_kind,
        capture.identity,
        view.id,
        view.revision,
      );
    }

    for (const relation of view.relations) this.insertRelation(view, relation);
    this.insertMaterialization(view, "primary", view.materialization.primary);
    for (const alternative of view.materialization.alternatives) {
      this.insertMaterialization(view, "alternative", alternative);
    }
    const previousPhase = transaction.phase;
    transaction.phase = "persist_search_projection";
    try {
      this.insertSearchProjection(view, view.time.created_at);
    } catch (error) {
      if (error instanceof ViewRepositoryError) throw error;
      throw this.problem(
        "invalid_request",
        error instanceof SqliteVecSemanticSearchError
          ? `View ${view.id}@${view.revision} has an invalid semantic search materialization`
          : `View ${view.id}@${view.revision} has an invalid search projection`,
        transaction,
        {},
        error,
      );
    }
    transaction.phase = previousPhase;
  }

  private persistSemanticSearch(
    view: View,
    plannedViews: ReadonlyMap<string, View>,
    transaction: TransactionContext,
  ): void {
    try {
      this.semantic_search?.insert(view, plannedViews);
    } catch (error) {
      if (error instanceof ViewRepositoryError) throw error;
      throw this.problem(
        "invalid_request",
        `View ${view.id}@${view.revision} has an invalid semantic search materialization`,
        transaction,
        {},
        error,
      );
    }
  }

  private insertRelation(view: View, relation: View["relations"][number]): void {
    const source = exactViewRef(view);
    const id = relationId(source, relation.type, relation.target, relation.metadata);
    this.db.prepare(`
      insert into view_relations_v1 (
        id, type, source_view_id, source_revision, target_view_id, target_revision, created_at, metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      relation.type,
      source.view_id,
      source.revision,
      relation.target.view_id,
      relation.target.revision,
      view.time.created_at,
      JSON.stringify(relation.metadata),
    );
  }

  private insertMaterialization(view: View, role: ViewMaterializationRole, materialization: ViewMaterialization): void {
    this.db.prepare(`
      insert into view_materializations_v1 (
        view_id, revision, materialization_id, role, generation, updated_at, materialization_json
      ) values (?, ?, ?, ?, 1, ?, ?)
    `).run(
      view.id,
      view.revision,
      materialization.id,
      role,
      view.time.created_at,
      JSON.stringify(materialization),
    );
  }

  private assertExactReference(
    ref: ExactViewRef,
    plannedViews: ReadonlyMap<string, View>,
    transaction: TransactionContext,
    label: string,
  ): void {
    if (this.resolveExactView(ref, plannedViews)) return;
    throw this.problem(
      "referential_integrity",
      `${label} ${viewKey(ref)} does not exist`,
      transaction,
    );
  }

  private resolveExactView(ref: ExactViewRef, plannedViews: ReadonlyMap<string, View>): View | undefined {
    return plannedViews.get(viewKey(ref)) ?? this.tryReadStoredView(ref.view_id, ref.revision);
  }

  private assertIdempotencyMatch(
    key: string,
    storedFingerprint: string | null,
    requestedFingerprint: string,
    transaction: TransactionContext,
  ): void {
    if (storedFingerprint === requestedFingerprint) return;
    throw this.problem(
      "idempotency_conflict",
      `Idempotency key ${key} was already used for a different View commit`,
      transaction,
      { idempotency_key: key },
    );
  }

  private readHead(id: string): HeadRow | undefined {
    return this.db.prepare("select revision from view_heads_v1 where id = ?").get(id) as HeadRow | undefined;
  }

  private isForgottenViewIdentity(viewId: string): boolean {
    return Boolean(this.db.prepare(`
      select 1 from privacy_forgotten_view_ids_v1 where view_id = ?
    `).get(viewId));
  }

  private readIdempotency(key: string): IdempotencyRow | undefined {
    return this.db.prepare(`
      select view_id, revision, request_fingerprint
      from view_idempotency_v1
      where idempotency_key = ?
    `).get(key) as IdempotencyRow | undefined;
  }

  private readCaptureIdentity(capture: NonNullable<View["provenance"]["capture"]>): CaptureIdentityRow | undefined {
    return this.db.prepare(`
      select view_id, first_revision
      from view_capture_identities_v1
      where connector = ? and connection_id = ? and source_id = ? and source_kind = ? and identity = ?
    `).get(
      capture.connector,
      capture.connection_id,
      capture.source_id,
      capture.source_kind,
      capture.identity,
    ) as CaptureIdentityRow | undefined;
  }

  private readForgetRequestRow(requestId: string): ForgetRequestRow | undefined {
    return this.db.prepare(`
      select status, plan_digest, request_json
      from privacy_forget_requests_v1 where request_id = ?
    `).get(requestId) as ForgetRequestRow | undefined;
  }

  private mustReadForgetRequest(requestId: string, transaction: TransactionContext): ForgetRequest {
    const row = this.readForgetRequestRow(requestId);
    if (!row) {
      throw this.problem("invalid_request", `Forget request ${requestId} does not exist`, transaction);
    }
    return this.parseForgetRequest(row.request_json);
  }

  private parseForgetRequest(value: string): ForgetRequest {
    try {
      const request = ForgetRequestSchema.parse(JSON.parse(value));
      const row = this.readForgetRequestRow(request.plan.request_id);
      if (row && (row.status !== request.status || row.plan_digest !== request.plan.plan_digest)) {
        throw new Error("Forget request normalized columns diverge from the content-free audit record");
      }
      return request;
    } catch (error) {
      throw new ViewRepositoryError(
        "stored Forget request failed schema validation",
        "corrupt_data",
        { operation: "parse_forget_request", table: "privacy_forget_requests_v1" },
        { cause: error },
      );
    }
  }

  private writeForgetRequest(request: ForgetRequest): void {
    const result = this.db.prepare(`
      update privacy_forget_requests_v1
      set status = ?, plan_digest = ?, updated_at = ?, request_json = ?
      where request_id = ?
    `).run(
      request.status,
      request.plan.plan_digest,
      request.updated_at,
      JSON.stringify(request),
      request.plan.request_id,
    );
    if (Number(result.changes) !== 1) {
      throw new ViewRepositoryError(
        `Forget request ${request.plan.request_id} disappeared during persistence`,
        "corrupt_data",
        { operation: "write_forget_request", table: "privacy_forget_requests_v1" },
      );
    }
  }

  private tryReadLatestView(id: string): View | undefined {
    const head = this.readHead(id);
    return head ? this.mustReadStoredView(id, Number(head.revision)) : undefined;
  }

  private tryReadStoredView(id: string, revision: number): View | undefined {
    const row = this.db.prepare(`
      select view_json from view_revisions_v1 where id = ? and revision = ?
    `).get(id, revision) as ViewRow | undefined;
    return row ? this.parseStoredJson(row.view_json) : undefined;
  }

  private mustReadStoredView(id: string, revision: number): View {
    const view = this.tryReadStoredView(id, revision);
    if (!view) {
      throw new ViewRepositoryError(
        `View ${id}@${revision} is missing`,
        "corrupt_data",
        { operation: "read_stored_view", view_ids: [id] },
      );
    }
    return view;
  }

  private exactViewExists(ref: ExactViewRef): boolean {
    return Boolean(this.db.prepare(`
      select 1 as found from view_revisions_v1 where id = ? and revision = ?
    `).get(ref.view_id, ref.revision));
  }

  private parseStoredJson(value: string): View {
    try {
      return parseView(JSON.parse(value));
    } catch (error) {
      throw new ViewRepositoryError(
        "stored View failed schema validation",
        "corrupt_data",
        { operation: "parse_stored_view" },
        { cause: error },
      );
    }
  }

  private parseRelationRow(row: RelationRow): ViewRelation {
    try {
      return ViewRelationSchema.parse({
        id: row.id,
        type: row.type,
        source: { view_id: row.source_view_id, revision: Number(row.source_revision) },
        target: { view_id: row.target_view_id, revision: Number(row.target_revision) },
        created_at: row.created_at,
        metadata: JSON.parse(row.metadata_json),
      });
    } catch (error) {
      throw new ViewRepositoryError(
        `stored View relation ${row.id} failed validation`,
        "corrupt_data",
        { operation: "parse_stored_relation", view_ids: [row.source_view_id, row.target_view_id] },
        { cause: error },
      );
    }
  }

  private parseMaterializationRow(row: MaterializationRow): StoredViewMaterialization {
    try {
      if (row.role !== "primary" && row.role !== "alternative" && row.role !== "derived") {
        throw new Error(`invalid Materialization role ${String(row.role)}`);
      }
      return {
        view: { view_id: row.view_id, revision: Number(row.revision) },
        role: row.role,
        materialization: ViewMaterializationSchema.parse(JSON.parse(row.materialization_json)),
        generation: Number(row.generation),
        updated_at: TimestampSchema.parse(row.updated_at),
      };
    } catch (error) {
      throw new ViewRepositoryError(
        `stored Materialization ${row.materialization_id} failed validation`,
        "corrupt_data",
        { operation: "parse_stored_materialization", view_ids: [row.view_id] },
        { cause: error },
      );
    }
  }

  private parseMaterialization(input: unknown, operation: string): ViewMaterialization {
    const parsed = ViewMaterializationSchema.safeParse(input);
    if (!parsed.success) {
      throw new ViewRepositoryError(
        "invalid Materialization",
        "invalid_request",
        { operation },
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private parseExactRef(input: unknown, operation: string): ExactViewRef {
    const parsed = ExactViewRefSchema.safeParse(input);
    if (!parsed.success) {
      throw new ViewRepositoryError(
        "invalid exact View reference",
        "invalid_request",
        { operation },
        { cause: parsed.error },
      );
    }
    return parsed.data;
  }

  private read<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ViewRepositoryError) throw error;
      throw new ViewRepositoryError(
        `SQLite View Store ${operation} failed`,
        "storage_failure",
        { operation, phase: "read", sqlite_code: sqliteCode(error) },
        { cause: error },
      );
    }
  }

  private transactionContext(operation: string, viewIds: string[]): TransactionContext {
    return { id: randomUUID(), operation, phase: "begin", viewIds: [...new Set(viewIds)] };
  }

  private withTransaction<T>(transaction: TransactionContext, fn: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const result = fn();
      transaction.phase = "commit";
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      let rollbackError: unknown;
      if (this.db.isTransaction) {
        try {
          this.db.exec("ROLLBACK");
        } catch (caught) {
          rollbackError = caught;
        }
      }
      if (error instanceof ViewRepositoryError && !rollbackError) {
        if (error.details.transaction_id) throw error;
        throw new ViewRepositoryError(
          error.message,
          error.code,
          {
            ...error.details,
            operation: transaction.operation,
            phase: transaction.phase,
            transaction_id: transaction.id,
            view_ids: transaction.viewIds.length > 0 ? transaction.viewIds : error.details.view_ids,
          },
          { cause: error },
        );
      }
      if (error instanceof ViewCommittedOutboxError && !rollbackError) throw error;
      if (error instanceof CaptureRuntimeError && !rollbackError) throw error;
      const cause = rollbackError
        ? new AggregateError([error, rollbackError], "View Store operation and rollback both failed")
        : error;
      throw new ViewRepositoryError(
        `SQLite View Store ${transaction.operation} failed during ${transaction.phase}`,
        "storage_failure",
        {
          operation: transaction.operation,
          phase: transaction.phase,
          transaction_id: transaction.id,
          view_ids: transaction.viewIds,
          sqlite_code: sqliteCode(error),
        },
        { cause },
      );
    }
  }

  private problem(
    code: ViewRepositoryErrorCode,
    message: string,
    transaction: TransactionContext,
    extra: { idempotency_key?: string } = {},
    cause?: unknown,
  ): ViewRepositoryError {
    return new ViewRepositoryError(
      message,
      code,
      {
        operation: transaction.operation,
        phase: transaction.phase,
        transaction_id: transaction.id,
        view_ids: transaction.viewIds,
        ...extra,
      },
      cause === undefined ? undefined : { cause },
    );
  }

  private migrate(): void {
    const transaction = this.transactionContext("migrate", []);
    this.withTransaction(transaction, () => {
      transaction.phase = "create_schema";
      this.createSchema();
      const stored = this.db.prepare(`
        select version from view_store_schema_versions_v1 where component = 'view-store'
      `).get() as StoredMigrationRow | undefined;
      const version = stored ? Number(stored.version) : 0;
      if (version > VIEW_STORE_MIGRATION_VERSION) {
        throw new ViewRepositoryError(
          `SQLite View Store schema version ${version} is newer than supported version ${VIEW_STORE_MIGRATION_VERSION}`,
          "storage_failure",
          { operation: "migrate", phase: "check_version", migration_version: version },
        );
      }
      if (version < 1) {
        transaction.phase = "ensure_legacy_columns";
        this.ensureColumn("view_idempotency_v1", "request_fingerprint", "text");
        transaction.phase = "normalize_legacy_views";
        this.normalizeLegacyStoredViews();
        transaction.phase = "backfill_normalized_state";
        this.backfillNormalizedState();
        transaction.phase = "rebuild_constraint_tables";
        this.rebuildConstraintTables();
        transaction.phase = "create_indexes";
        this.createIndexes();
      }
      if (version < 5) {
        transaction.phase = "rebuild_search_projection";
        this.resetSearchProjection(normalizeTimestamp(this.now()));
      }
      if (version < VIEW_STORE_MIGRATION_VERSION) {
        transaction.phase = "create_capture_runtime_schema";
        this.createIndexes();
        transaction.phase = "record_version";
        this.db.prepare(`
          insert into view_store_schema_versions_v1 (component, version, migrated_at)
          values ('view-store', ?, ?)
          on conflict(component) do update set version = excluded.version, migrated_at = excluded.migrated_at
        `).run(VIEW_STORE_MIGRATION_VERSION, normalizeTimestamp(this.now()));
      }
      transaction.phase = "check_search_index_version";
      const searchStored = this.db.prepare(`
        select version from view_search_schema_versions_v1 where component = 'view-search-index'
      `).get() as StoredMigrationRow | undefined;
      const searchVersion = searchStored ? Number(searchStored.version) : 0;
      if (searchVersion > VIEW_SEARCH_INDEX_MIGRATION_VERSION) {
        throw new ViewRepositoryError(
          `SQLite Search index schema version ${searchVersion} is newer than supported version ${VIEW_SEARCH_INDEX_MIGRATION_VERSION}`,
          "storage_failure",
          { operation: "migrate", phase: "check_search_index_version", migration_version: searchVersion },
        );
      }
      if (searchVersion < VIEW_SEARCH_INDEX_MIGRATION_VERSION) {
        transaction.phase = "rebuild_search_location_index";
        this.resetSearchProjection(normalizeTimestamp(this.now()));
        transaction.phase = "record_search_index_version";
        this.db.prepare(`
          insert into view_search_schema_versions_v1 (component, version, migrated_at)
          values ('view-search-index', ?, ?)
          on conflict(component) do update set version = excluded.version, migrated_at = excluded.migrated_at
        `).run(VIEW_SEARCH_INDEX_MIGRATION_VERSION, normalizeTimestamp(this.now()));
      }
      transaction.phase = "validate_schema";
      this.validateSchemaInvariants();
    });
  }

  private createSchema(): void {
    this.db.exec(`
      create table if not exists view_revisions_v1 (
        id text not null,
        revision integer not null check(revision > 0),
        schema_name text not null,
        schema_version integer not null check(schema_version > 0),
        role text not null check(role in ('raw', 'derived')),
        name text not null,
        created_at text not null,
        view_json text not null,
        primary key (id, revision)
      );

      create table if not exists view_heads_v1 (
        id text primary key,
        revision integer not null check(revision > 0),
        updated_at text not null,
        foreign key (id, revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );

      create table if not exists view_idempotency_v1 (
        idempotency_key text primary key,
        request_fingerprint text not null,
        view_id text not null,
        revision integer not null check(revision > 0),
        created_at text not null,
        foreign key (view_id, revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );

      create table if not exists view_relations_v1 (
        id text primary key,
        type text not null,
        source_view_id text not null,
        source_revision integer not null,
        target_view_id text not null,
        target_revision integer not null,
        created_at text not null,
        metadata_json text not null,
        foreign key (source_view_id, source_revision) references view_revisions_v1(id, revision)
          deferrable initially deferred,
        foreign key (target_view_id, target_revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );

      create table if not exists view_capture_identities_v1 (
        connector text not null,
        connection_id text not null,
        source_id text not null,
        source_kind text not null,
        identity text not null check(identity in ('stable_source', 'occurrence')),
        view_id text not null,
        first_revision integer not null check(first_revision = 1),
        primary key (connector, connection_id, source_id, source_kind, identity),
        foreign key (view_id, first_revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );

      create table if not exists view_materializations_v1 (
        view_id text not null,
        revision integer not null,
        materialization_id text not null,
        role text not null check(role in ('primary', 'alternative', 'derived')),
        generation integer not null check(generation > 0),
        updated_at text not null,
        materialization_json text not null,
        primary key (view_id, revision, materialization_id),
        foreign key (view_id, revision) references view_revisions_v1(id, revision)
          on delete cascade deferrable initially deferred
      );

      create table if not exists view_search_projection_v1 (
        search_rowid integer primary key,
        view_id text not null,
        revision integer not null check(revision > 0),
        schema_name text not null,
        schema_version integer not null check(schema_version > 0),
        projection_version integer not null check(projection_version = 1),
        projection_digest text not null,
        indexed_at text not null,
        unique(view_id, revision),
        foreign key (view_id, revision) references view_revisions_v1(id, revision)
          on delete cascade deferrable initially deferred
      );

      create virtual table if not exists view_search_fts_v1 using fts5(
        title,
        text,
        identifiers,
        urls,
        timestamps,
        provenance,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      create table if not exists view_search_units_v2 (
        search_unit_id integer primary key,
        view_id text not null,
        revision integer not null check(revision > 0),
        ordinal integer not null check(ordinal >= 0),
        category text not null check(category in ('title', 'text', 'identifier', 'url', 'timestamp', 'provenance')),
        expanded_path text not null,
        value_digest text not null,
        indexed_at text not null,
        unique(view_id, revision, ordinal, expanded_path),
        foreign key (view_id, revision) references view_revisions_v1(id, revision)
          on delete cascade deferrable initially deferred
      );

      create virtual table if not exists view_search_unit_fts_v2 using fts5(
        title,
        text,
        identifiers,
        urls,
        timestamps,
        provenance,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      create table if not exists view_search_vector_profiles_v1 (
        profile_id text not null,
        profile_revision integer not null check(profile_revision > 0),
        provider text not null,
        model text not null,
        dimension integer not null check(dimension > 0 and dimension <= 4096),
        distance_metric text not null check(distance_metric in ('cosine', 'l2')),
        table_name text not null unique,
        extension_version text not null,
        created_at text not null,
        primary key (profile_id, profile_revision)
      );

      create table if not exists view_search_vectors_v1 (
        vector_rowid integer not null check(vector_rowid > 0),
        embedding_view_id text not null,
        embedding_revision integer not null check(embedding_revision > 0),
        target_view_id text not null,
        target_revision integer not null check(target_revision > 0),
        target_kind text not null check(target_kind in ('envelope', 'representation')),
        target_path text not null,
        target_key text not null,
        profile_id text not null,
        profile_revision integer not null check(profile_revision > 0),
        dimension integer not null check(dimension > 0 and dimension <= 4096),
        distance_metric text not null check(distance_metric in ('cosine', 'l2')),
        source_digest text not null,
        indexed_at text not null,
        unique(embedding_view_id, embedding_revision),
        foreign key (embedding_view_id, embedding_revision) references view_revisions_v1(id, revision)
          on delete cascade deferrable initially deferred,
        foreign key (target_view_id, target_revision) references view_revisions_v1(id, revision)
          on delete cascade deferrable initially deferred,
        foreign key (profile_id, profile_revision) references view_search_vector_profiles_v1(profile_id, profile_revision)
          deferrable initially deferred,
        primary key (profile_id, profile_revision, vector_rowid)
      );

      create table if not exists view_search_reindex_runs_v1 (
        run_id text primary key,
        status text not null check(status in ('running', 'succeeded', 'failed')),
        request_fingerprint text not null,
        started_at text not null,
        completed_at text,
        report_json text,
        error_json text
      );

      create table if not exists view_commit_outbox_v1 (
        sequence integer primary key autoincrement,
        event_id text not null unique,
        batch_id text not null,
        transaction_id text not null unique,
        status text not null check(status in ('pending', 'leased', 'acknowledged', 'poison')),
        delivery_attempts integer not null default 0 check(delivery_attempts >= 0),
        available_at text not null,
        leased_by text,
        lease_expires_at text,
        acknowledged_at text,
        poisoned_at text,
        last_error_json text,
        created_at text not null,
        event_json text not null,
        check((status = 'leased') = (leased_by is not null and lease_expires_at is not null)),
        check((status = 'acknowledged') = (acknowledged_at is not null)),
        check((status = 'poison') = (poisoned_at is not null)),
        check(status != 'poison' or last_error_json is not null)
      );

      create table if not exists view_commit_outbox_refs_v1 (
        event_id text not null references view_commit_outbox_v1(event_id) on delete cascade,
        view_id text not null,
        revision integer not null check(revision > 0),
        primary key (event_id, view_id, revision)
      );

      create table if not exists view_store_schema_versions_v1 (
        component text primary key check(component = 'view-store'),
        version integer not null check(version > 0),
        migrated_at text not null
      );

      create table if not exists view_search_schema_versions_v1 (
        component text primary key check(component = 'view-search-index'),
        version integer not null check(version > 0),
        migrated_at text not null
      );

      create table if not exists privacy_forget_requests_v1 (
        request_id text primary key,
        status text not null check(status in ('previewed', 'running', 'failed', 'succeeded')),
        plan_digest text not null,
        created_at text not null,
        updated_at text not null,
        request_json text not null
      );

      create table if not exists privacy_forgotten_view_ids_v1 (
        view_id text primary key,
        request_id text not null references privacy_forget_requests_v1(request_id),
        forgotten_at text not null
      );

      create table if not exists execution_runs_v1 (
        run_id text primary key,
        status text not null check(status in ('ready', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
        created_at text not null,
        updated_at text not null,
        run_json text not null
      );

      create table if not exists execution_attempts_v1 (
        attempt_id text primary key,
        run_id text not null references execution_runs_v1(run_id),
        sequence integer not null check(sequence > 0),
        previous_attempt_id text,
        status text not null check(status in ('running', 'succeeded', 'failed', 'cancelled', 'timed_out')),
        started_at text not null,
        completed_at text,
        attempt_json text not null,
        unique(run_id, sequence)
      );

      create table if not exists execution_trace_v1 (
        sequence integer primary key autoincrement,
        run_id text not null references execution_runs_v1(run_id),
        attempt_id text references execution_attempts_v1(attempt_id),
        type text not null,
        occurred_at text not null,
        event_json text not null
      );

      create table if not exists execution_idempotency_v1 (
        idempotency_key text primary key,
        request_fingerprint text not null,
        run_id text not null unique references execution_runs_v1(run_id),
        created_at text not null
      );

      create table if not exists capture_connections_v1 (
        connection_id text primary key,
        connector_id text not null,
        connector_version text not null,
        connection_fingerprint text not null,
        connection_json text not null,
        manifest_json text not null,
        checkpoint_json text not null,
        health_json text not null,
        paused integer not null default 0 check(paused in (0, 1)),
        in_flight integer not null default 0 check(in_flight >= 0),
        updated_at text not null
      );

      create table if not exists capture_batches_v1 (
        idempotency_key text primary key,
        request_fingerprint text not null,
        batch_id text not null,
        connection_id text not null references capture_connections_v1(connection_id),
        result_json text not null,
        created_at text not null
      );

      create table if not exists capture_trace_v1 (
        sequence integer primary key autoincrement,
        connection_id text not null references capture_connections_v1(connection_id),
        batch_id text,
        type text not null,
        occurred_at text not null,
        event_json text not null
      );

      create table if not exists capture_dead_letters_v1 (
        id text primary key,
        connection_id text not null references capture_connections_v1(connection_id),
        status text not null check(status in ('pending', 'resolved')),
        created_at text not null,
        dead_letter_json text not null
      );
    `);
    this.createIndexes();
  }

  private createIndexes(): void {
    this.db.exec(`
      create index if not exists idx_view_revisions_v1_schema on view_revisions_v1(schema_name, schema_version);
      create index if not exists idx_view_revisions_v1_role on view_revisions_v1(role);
      create index if not exists idx_view_heads_v1_updated on view_heads_v1(updated_at);
      create index if not exists idx_view_relations_v1_source on view_relations_v1(source_view_id, source_revision, type);
      create index if not exists idx_view_relations_v1_target on view_relations_v1(target_view_id, target_revision, type);
      create index if not exists idx_view_capture_identities_v1_view on view_capture_identities_v1(view_id);
      create index if not exists idx_view_materializations_v1_view on view_materializations_v1(view_id, revision, role);
      create index if not exists idx_view_search_projection_v1_schema on view_search_projection_v1(schema_name, schema_version);
      create index if not exists idx_view_search_units_v2_ref on view_search_units_v2(view_id, revision, ordinal, expanded_path);
      create index if not exists idx_view_search_vectors_v1_target on view_search_vectors_v1(target_view_id, target_revision, profile_id, profile_revision);
      create index if not exists idx_view_search_vectors_v1_embedding on view_search_vectors_v1(embedding_view_id, embedding_revision);
      create index if not exists idx_view_search_vectors_v1_profile on view_search_vectors_v1(profile_id, profile_revision, target_key, target_kind);
      create index if not exists idx_view_search_reindex_runs_v1_status on view_search_reindex_runs_v1(status, started_at);
      create index if not exists idx_view_commit_outbox_v1_poll on view_commit_outbox_v1(status, available_at, sequence);
      create index if not exists idx_view_commit_outbox_v1_lease on view_commit_outbox_v1(status, lease_expires_at, sequence);
      create index if not exists idx_view_commit_outbox_refs_v1_view on view_commit_outbox_refs_v1(view_id, revision, event_id);
      create index if not exists idx_privacy_forget_requests_v1_status on privacy_forget_requests_v1(status, updated_at);
      create index if not exists idx_privacy_forgotten_view_ids_v1_request on privacy_forgotten_view_ids_v1(request_id);
      create index if not exists idx_execution_attempts_v1_run on execution_attempts_v1(run_id, sequence);
      create index if not exists idx_execution_trace_v1_run on execution_trace_v1(run_id, sequence);
      create index if not exists idx_execution_idempotency_v1_run on execution_idempotency_v1(run_id);
      create index if not exists idx_capture_batches_v1_connection on capture_batches_v1(connection_id, created_at);
      create index if not exists idx_capture_trace_v1_connection on capture_trace_v1(connection_id, sequence);
      create index if not exists idx_capture_dead_letters_v1_connection on capture_dead_letters_v1(connection_id, status, created_at);
    `);
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    const columns = this.db.prepare(`pragma table_info(${table})`).all() as ColumnRow[];
    if (!columns.some(item => item.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${declaration}`);
    }
  }

  private normalizeLegacyStoredViews(): void {
    const rows = this.db.prepare(`
      select id, revision, view_json from view_revisions_v1 order by id, revision
    `).all() as Array<ViewRow & { id: string; revision: number }>;
    const update = this.db.prepare(`
      update view_revisions_v1 set view_json = ? where id = ? and revision = ?
    `);
    for (const row of rows) {
      let input: unknown;
      try {
        input = JSON.parse(row.view_json);
        removeEmptyLegacyMaterializationMetadata(input);
        const view = parseView(input);
        update.run(JSON.stringify(view), row.id, Number(row.revision));
      } catch (error) {
        if (error instanceof ViewRepositoryError) throw error;
        throw new ViewRepositoryError(
          `stored View ${row.id}@${row.revision} cannot be migrated to the current contract`,
          "corrupt_data",
          {
            operation: "migrate",
            phase: "normalize_legacy_views",
            table: "view_revisions_v1",
            view_ids: [row.id],
            revision: Number(row.revision),
          },
          { cause: error },
        );
      }
    }
  }

  private backfillNormalizedState(): void {
    const rows = this.db.prepare("select id, revision, view_json from view_revisions_v1 order by id, revision")
      .all() as Array<ViewRow & { id: string; revision: number }>;
    for (const row of rows) {
      let view: View;
      try {
        view = this.parseStoredJson(row.view_json);
      } catch (error) {
        throw new ViewRepositoryError(
          `stored View ${row.id}@${row.revision} failed normalized-state backfill`,
          "corrupt_data",
          {
            operation: "migrate",
            phase: "backfill_normalized_state",
            table: "view_revisions_v1",
            view_ids: [row.id],
            revision: Number(row.revision),
          },
          { cause: error },
        );
      }
      if (view.revision === 1 && view.provenance.capture) this.backfillCaptureIdentity(view);
      for (const relation of view.relations) {
        const source = exactViewRef(view);
        this.db.prepare(`
          insert or ignore into view_relations_v1 (
            id, type, source_view_id, source_revision, target_view_id, target_revision, created_at, metadata_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          relationId(source, relation.type, relation.target, relation.metadata),
          relation.type,
          source.view_id,
          source.revision,
          relation.target.view_id,
          relation.target.revision,
          view.time.created_at,
          JSON.stringify(relation.metadata),
        );
      }
      this.backfillMaterialization(view, "primary", view.materialization.primary);
      for (const alternative of view.materialization.alternatives) {
        this.backfillMaterialization(view, "alternative", alternative);
      }
      const normalizedRows = this.db.prepare(`
        select view_id, revision, materialization_id, role, generation, updated_at, materialization_json
        from view_materializations_v1 where view_id = ? and revision = ?
      `).all(view.id, view.revision) as MaterializationRow[];
      this.assertManifestMaterializations(
        view,
        normalizedRows.map(row => this.parseMaterializationRow(row)),
        "migrate",
      );
    }
    const idempotencyRows = this.db.prepare(`
      select view_id, revision, request_fingerprint, idempotency_key
      from view_idempotency_v1
    `).all() as Array<IdempotencyRow & { idempotency_key: string }>;
    for (const row of idempotencyRows) {
      const view = this.mustReadStoredView(row.view_id, Number(row.revision));
      const { revision: _revision, ...draft } = view;
      this.db.prepare(`
        update view_idempotency_v1 set request_fingerprint = ? where idempotency_key = ?
      `).run(commitFingerprint(parseViewDraft(draft), view.revision - 1), row.idempotency_key);
    }
  }

  private rebuildConstraintTables(): void {
    this.db.exec(`
      drop table if exists view_heads_v1_next;
      create table view_heads_v1_next (
        id text primary key,
        revision integer not null check(revision > 0),
        updated_at text not null,
        foreign key (id, revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );
      insert into view_heads_v1_next (id, revision, updated_at)
        select id, revision, updated_at from view_heads_v1;
      drop table view_heads_v1;
      alter table view_heads_v1_next rename to view_heads_v1;

      drop table if exists view_idempotency_v1_next;
      create table view_idempotency_v1_next (
        idempotency_key text primary key,
        request_fingerprint text not null,
        view_id text not null,
        revision integer not null check(revision > 0),
        created_at text not null,
        foreign key (view_id, revision) references view_revisions_v1(id, revision)
          deferrable initially deferred
      );
      insert into view_idempotency_v1_next (
        idempotency_key, request_fingerprint, view_id, revision, created_at
      ) select idempotency_key, request_fingerprint, view_id, revision, created_at
        from view_idempotency_v1;
      drop table view_idempotency_v1;
      alter table view_idempotency_v1_next rename to view_idempotency_v1;
    `);
  }

  private validateSchemaInvariants(): void {
    const fingerprint = (this.db.prepare("pragma table_info(view_idempotency_v1)").all() as TableInfoRow[])
      .find(column => column.name === "request_fingerprint");
    const headForeignKeys = this.db.prepare("pragma foreign_key_list(view_heads_v1)").all() as ForeignKeyRow[];
    const idempotencyForeignKeys = this.db.prepare("pragma foreign_key_list(view_idempotency_v1)").all() as ForeignKeyRow[];
    const requiredTables = [
      "capture_connections_v1",
      "capture_batches_v1",
      "capture_trace_v1",
      "capture_dead_letters_v1",
      "privacy_forget_requests_v1",
      "privacy_forgotten_view_ids_v1",
      "view_search_projection_v1",
      "view_search_fts_v1",
      "view_search_units_v2",
      "view_search_unit_fts_v2",
      "view_search_vector_profiles_v1",
      "view_search_vectors_v1",
      "view_search_schema_versions_v1",
      "view_search_reindex_runs_v1",
      "view_commit_outbox_v1",
      "view_commit_outbox_refs_v1",
    ];
    const missingRequiredTable = requiredTables.find(table => !(this.db.prepare(`select name from sqlite_master where type = 'table' and name = ?`).get(table)));
    if (!fingerprint || fingerprint.notnull !== 1 || missingRequiredTable || !headForeignKeys.some(key => key.table === "view_revisions_v1")
      || !idempotencyForeignKeys.some(key => key.table === "view_revisions_v1")) {
      throw new ViewRepositoryError(
        "SQLite View Store schema invariants are incomplete after migration",
        "storage_failure",
        { operation: "migrate", phase: "validate_schema", migration_version: VIEW_STORE_MIGRATION_VERSION },
      );
    }
    const violations = this.db.prepare("pragma foreign_key_check").all() as ForeignKeyCheckRow[];
    const violation = violations[0];
    if (violation) {
      throw new ViewRepositoryError(
        `SQLite View Store foreign key violation in ${violation.table}`,
        "corrupt_data",
        {
          operation: "migrate",
          phase: "foreign_key_check",
          table: violation.table,
          migration_version: VIEW_STORE_MIGRATION_VERSION,
        },
      );
    }
  }

  private backfillMaterialization(view: View, role: ViewMaterializationRole, materialization: ViewMaterialization): void {
    const existing = this.db.prepare(`
      select role, generation from view_materializations_v1
      where view_id = ? and revision = ? and materialization_id = ?
    `).get(view.id, view.revision, materialization.id) as { role: string; generation: number } | undefined;
    if (existing && (existing.role !== role || Number(existing.generation) !== 1)) {
      throw new ViewRepositoryError(
        `Manifest Materialization ${materialization.id} for ${view.id}@${view.revision} conflicts with persisted normalized state`,
        "corrupt_data",
        {
          operation: "migrate",
          phase: "backfill_normalized_state",
          table: "view_materializations_v1",
          view_ids: [view.id],
          revision: view.revision,
        },
      );
    }
    this.db.prepare(`
      insert into view_materializations_v1 (
        view_id, revision, materialization_id, role, generation, updated_at, materialization_json
      ) values (?, ?, ?, ?, 1, ?, ?)
      on conflict(view_id, revision, materialization_id) do update set
        role = excluded.role,
        generation = excluded.generation,
        updated_at = excluded.updated_at,
        materialization_json = excluded.materialization_json
    `).run(
      view.id,
      view.revision,
      materialization.id,
      role,
      view.time.created_at,
      JSON.stringify(materialization),
    );
  }

  private assertManifestMaterializations(
    view: View,
    stored: StoredViewMaterialization[],
    operation: string,
  ): void {
    const expected = new Map<string, { role: "primary" | "alternative"; materialization: ViewMaterialization }>([
      [view.materialization.primary.id, { role: "primary", materialization: view.materialization.primary }],
      ...view.materialization.alternatives.map(item => [
        item.id,
        { role: "alternative" as const, materialization: item },
      ] as const),
    ]);
    const manifestRows = stored.filter(item => item.role !== "derived");
    const valid = manifestRows.length === expected.size && manifestRows.every(item => {
      const declared = expected.get(item.materialization.id);
      return declared
        && declared.role === item.role
        && item.generation === 1
        && canonicalJson(declared.materialization) === canonicalJson(item.materialization);
    });
    if (valid) return;
    throw new ViewRepositoryError(
      `Persisted manifest Materializations do not match View ${view.id}@${view.revision}`,
      "corrupt_data",
      {
        operation,
        phase: operation === "migrate" ? "backfill_normalized_state" : "validate_materializations",
        table: "view_materializations_v1",
        view_ids: [view.id],
        revision: view.revision,
      },
    );
  }

  private backfillCaptureIdentity(view: View): void {
    const capture = view.provenance.capture;
    if (!capture) return;
    const existing = this.readCaptureIdentity(capture);
    if (existing && existing.view_id !== view.id) {
      throw new ViewRepositoryError(
        `Captured source ${captureIdentityKey(capture)} maps to both ${existing.view_id} and ${view.id}`,
        "corrupt_data",
        { operation: "migrate", phase: "backfill_capture_identity", view_ids: [existing.view_id, view.id] },
      );
    }
    if (!existing) {
      this.db.prepare(`
        insert into view_capture_identities_v1 (
          connector, connection_id, source_id, source_kind, identity, view_id, first_revision
        ) values (?, ?, ?, ?, ?, ?, 1)
      `).run(
        capture.connector,
        capture.connection_id,
        capture.source_id,
        capture.source_kind,
        capture.identity,
        view.id,
      );
    }
  }

  private insertSearchProjection(view: View, indexedAt: string): boolean {
    const document = projectViewForSearch(view);
    if (!document) return false;
    const inserted = this.db.prepare(`
      insert into view_search_projection_v1 (
        view_id, revision, schema_name, schema_version, projection_version, projection_digest, indexed_at
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      view.id,
      view.revision,
      view.schema.name,
      view.schema.version,
      document.projection_version,
      document.digest,
      indexedAt,
    );
    const rowid = Number(inserted.lastInsertRowid);
    this.db.prepare(`
      insert into view_search_fts_v1 (
        rowid, title, text, identifiers, urls, timestamps, provenance
      ) values (?, ?, ?, ?, ?, ?, ?)
    `).run(
      rowid,
      document.title.join("\n"),
      document.text.join("\n"),
      document.identifiers.join("\n"),
      document.urls.join("\n"),
      document.timestamps.join("\n"),
      document.provenance.join("\n"),
    );
    insertSqliteSearchUnits(this.db, view, indexedAt);
    return true;
  }

  private deleteSearchProjection(ref: ExactViewRef): number {
    const semanticRemoved = this.semantic_search?.delete(ref) ?? 0;
    deleteSqliteSearchUnits(this.db, ref);
    const row = this.db.prepare(`
      select search_rowid, view_id, revision, projection_digest
      from view_search_projection_v1 where view_id = ? and revision = ?
    `).get(ref.view_id, ref.revision) as SearchProjectionRow | undefined;
    if (!row) return semanticRemoved;
    this.db.prepare("delete from view_search_fts_v1 where rowid = ?").run(Number(row.search_rowid));
    this.db.prepare("delete from view_search_projection_v1 where search_rowid = ?").run(Number(row.search_rowid));
    return 1 + semanticRemoved;
  }

  private resetSearchProjection(indexedAt: string): void {
    this.db.exec(`
      delete from view_search_unit_fts_v2;
      delete from view_search_units_v2;
      delete from view_search_fts_v1;
      delete from view_search_projection_v1;
    `);
    const rows = this.db.prepare("select view_json from view_revisions_v1 order by id, revision").all() as ViewRow[];
    for (const row of rows) this.insertSearchProjection(this.parseStoredJson(row.view_json), indexedAt);
  }

  private rebuildSearchProjection(indexedAt: string): {
    scanned: number;
    indexed: number;
    excluded: number;
    unchanged: number;
    removed: number;
  } {
    const existing = new Map<string, SearchProjectionRow>();
    const existingRows = this.db.prepare(`
      select search_rowid, view_id, revision, projection_digest
      from view_search_projection_v1
    `).all() as SearchProjectionRow[];
    for (const row of existingRows) existing.set(`${row.view_id}@${row.revision}`, row);

    let indexed = 0;
    let excluded = 0;
    let unchanged = 0;
    let removed = 0;
    const rows = this.db.prepare("select view_json from view_revisions_v1 order by id, revision").all() as ViewRow[];
    for (const row of rows) {
      const view = this.parseStoredJson(row.view_json);
      const key = `${view.id}@${view.revision}`;
      const current = existing.get(key);
      existing.delete(key);
      const projected = projectViewForSearch(view);
      if (!projected) {
        excluded += 1;
        if (current) removed += this.deleteSearchProjection(exactViewRef(view));
        continue;
      }
      const ftsExists = current
        ? Boolean(this.db.prepare("select rowid from view_search_fts_v1 where rowid = ?").get(Number(current.search_rowid)))
        : false;
      if (current && current.projection_digest === projected.digest && ftsExists && sqliteSearchUnitsMatch(this.db, view)) {
        unchanged += 1;
        continue;
      }
      if (current) removed += this.deleteSearchProjection(exactViewRef(view));
      else deleteSqliteSearchUnits(this.db, exactViewRef(view));
      this.insertSearchProjection(view, indexedAt);
      indexed += 1;
    }
    for (const orphan of existing.values()) {
      this.deleteSearchProjection({ view_id: orphan.view_id, revision: Number(orphan.revision) });
      removed += 1;
    }
    const orphanFts = this.db.prepare(`
      delete from view_search_fts_v1
      where rowid not in (select search_rowid from view_search_projection_v1)
    `).run();
    removed += Number(orphanFts.changes);
    const orphanUnits = this.db.prepare(`
      select distinct u.view_id, u.revision
      from view_search_units_v2 u
      left join view_search_projection_v1 p on p.view_id = u.view_id and p.revision = u.revision
      where p.search_rowid is null
    `).all() as Array<{ view_id: string; revision: number }>;
    for (const orphan of orphanUnits) {
      deleteSqliteSearchUnits(this.db, { view_id: orphan.view_id, revision: Number(orphan.revision) });
      removed += 1;
    }
    const orphanUnitFts = this.db.prepare(`
      delete from view_search_unit_fts_v2
      where rowid not in (select search_unit_id from view_search_units_v2)
    `).run();
    removed += Number(orphanUnitFts.changes);
    return { scanned: rows.length, indexed, excluded, unchanged, removed };
  }

  private readAllStoredViews(): View[] {
    const rows = this.db.prepare("select view_json from view_revisions_v1 order by id, revision").all() as ViewRow[];
    return rows.map(row => this.parseStoredJson(row.view_json));
  }
}

function removeEmptyLegacyMaterializationMetadata(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const materialization = (input as Record<string, unknown>).materialization;
  if (!materialization || typeof materialization !== "object" || Array.isArray(materialization)) return;
  const manifest = materialization as Record<string, unknown>;
  const entries = [manifest.primary, ...(Array.isArray(manifest.alternatives) ? manifest.alternatives : [])];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!("metadata" in record)) continue;
    const metadata = record.metadata;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && Object.keys(metadata).length === 0) {
      delete record.metadata;
      continue;
    }
    throw new Error("legacy Materialization metadata is non-empty and has no lossless current representation");
  }
}

function commitFingerprint(draft: ViewDraft, expectedRevision: number): string {
  const { trace_id: _traceId, ...stableProvenance } = draft.provenance;
  const { created_at: _createdAt, ...stableTime } = draft.time;
  const stableDraft = { ...draft, time: stableTime, provenance: stableProvenance };
  return createHash("sha256")
    .update(canonicalJson({ draft: stableDraft, expected_revision: expectedRevision }))
    .digest("hex");
}

function executionRunFingerprint(run: ExecutionRun): string {
  return createHash("sha256")
    .update(canonicalJson({
      run_id: run.id,
      correlation_id: run.correlation_id,
      frozen: run.frozen,
    }))
    .digest("hex");
}

function captureConnectionFingerprint(connection: SourceConnection, manifest: ConnectorManifest): string {
  return createHash("sha256").update(canonicalJson({ connection, manifest })).digest("hex");
}

function captureBatchFingerprint(batch: import("@info/capture").CaptureBatch): string {
  const { created_at: _createdAt, candidates, ...stableBatch } = batch;
  const stableCandidates = candidates.map(({ captured_at: _capturedAt, ...candidate }) => candidate);
  const checkpoint = batch.checkpoint ? { next: batch.checkpoint.next } : undefined;
  return createHash("sha256")
    .update(canonicalJson({ ...stableBatch, candidates: stableCandidates, checkpoint }))
    .digest("hex");
}

function importCaptureSafeError(error: import("@info/capture").CaptureSafeError) {
  return CaptureSafeErrorSchema.parse(error);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ViewRepositoryError(
      `${label} contains invalid JSON`,
      "corrupt_data",
      { operation: "parse_stored_json" },
      { cause: error },
    );
  }
}

function captureIdentityKey(capture: NonNullable<View["provenance"]["capture"]>): string {
  return canonicalJson({
    connector: capture.connector,
    connection_id: capture.connection_id,
    source_id: capture.source_id,
    source_kind: capture.source_kind,
    identity: capture.identity,
  });
}

function relationId(
  source: ExactViewRef,
  type: string,
  target: ExactViewRef,
  metadata: View["relations"][number]["metadata"],
): string {
  const digest = createHash("sha256")
    .update(canonicalJson({ source, type, target, metadata }))
    .digest("hex");
  return `relation:${digest}`;
}

function viewKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function requiredString(value: unknown, field: string, operation: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new ViewRepositoryError(
    `${field} is required`,
    "invalid_request",
    { operation, phase: "validate_input" },
  );
}

function invalidRequest(message: string, operation: string): ViewRepositoryError {
  return new ViewRepositoryError(
    message,
    "invalid_request",
    { operation, phase: "validate_input" },
  );
}

function queryList(
  value: unknown,
  field: string,
  isEntry: (entry: unknown) => boolean,
): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => !isEntry(entry))) {
    throw invalidRequest(`query ${field} must be a non-empty array of valid values`, "query");
  }
  return [...new Set(value.map(entry => (entry as string).trim()))];
}

function sqlPlaceholders(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw invalidRequest("query filter must contain at least one value", "query");
  }
  return new Array(count).fill("?").join(", ");
}

function parseQueryTimeRange(value: unknown): {
  basis: "observed_at" | "created_at";
  startEpochSeconds: number;
  endEpochSeconds: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("query time_range must be an object", "query");
  }
  const range = value as { basis?: unknown; start?: unknown; end?: unknown };
  if (range.basis !== "observed_at" && range.basis !== "created_at") {
    throw invalidRequest("query time_range basis must be observed_at or created_at", "query");
  }
  const start = parseQueryTimestamp(range.start, "time_range.start");
  const end = parseQueryTimestamp(range.end, "time_range.end");
  if (start >= end) {
    throw invalidRequest("query time_range requires start to be before end", "query");
  }
  return {
    basis: range.basis,
    startEpochSeconds: start / 1_000,
    endEpochSeconds: end / 1_000,
  };
}

function parseQueryTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || !TimestampSchema.safeParse(value).success) {
    throw invalidRequest(`query ${field} must be an ISO timestamp with an offset`, "query");
  }
  const epochMilliseconds = Date.parse(value);
  if (!Number.isFinite(epochMilliseconds)) {
    throw invalidRequest(`query ${field} must resolve to a finite timestamp`, "query");
  }
  return epochMilliseconds;
}

function normalizeTimestamp(value: unknown): string {
  const parsed = TimestampSchema.parse(value);
  return new Date(parsed).toISOString();
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number, operation: string): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ViewRepositoryError(
      `limit must be an integer between 1 and ${maximum}`,
      "invalid_request",
      { operation, phase: "validate_input" },
    );
  }
  return limit;
}

function sqliteCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function searchReindexSafeError(error: unknown): { name: string; message: string; code?: string } {
  if (error instanceof ViewRepositoryError) {
    return { name: error.name, message: error.message, code: error.code };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "UnknownError", message: String(error) };
}
