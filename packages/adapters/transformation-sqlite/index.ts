import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TransformationRepositoryError,
  assertTransformationRevisionTransition,
  exactTransformationRef,
  parseTransformation,
  type CommitTransformationInput,
  type CommitTransformationResult,
  type ExactTransformationRef,
  type Transformation,
  type TransformationRepository,
  type TransformationRepositoryErrorCode,
} from "@info/transformation";
import { canonicalJson } from "@info/view";

type TransactionContext = {
  id: string;
  operation: string;
  phase: string;
  transformationId?: string;
};

type HeadRow = { revision: number };
type RevisionRow = { transformation_json: string };
type IdempotencyRow = {
  request_fingerprint: string;
  transformation_id: string;
  revision: number;
};
type VersionRow = { version: number };

const SCHEMA_VERSION = 1;

export type SqliteTransformationRepositoryOptions = {
  busy_timeout_ms?: number;
};

export class SqliteTransformationRepository implements TransformationRepository {
  private readonly db: DatabaseSync;

  constructor(
    dbPath = process.env.METAFLOW_VIEW_DB_PATH ?? process.env.CONTEXT_DB_PATH ?? "data/context.sqlite",
    options: SqliteTransformationRepositoryOptions = {},
  ) {
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath, {
        enableForeignKeyConstraints: true,
        timeout: options.busy_timeout_ms ?? 5_000,
      });
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      if (error instanceof TransformationRepositoryError) throw error;
      throw new TransformationRepositoryError(
        "failed to initialize SQLite Transformation Repository",
        "storage_failure",
        { operation: "migrate", phase: "initialize", sqlite_code: sqliteCode(error) },
        { cause: error },
      );
    }
  }

  async commit(input: CommitTransformationInput): Promise<CommitTransformationResult> {
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 0) {
      throw new TransformationRepositoryError(
        "Transformation commit requires a non-negative expected_revision",
        "invalid_request",
        { operation: "commit", phase: "validate_input", expected_revision: input.expected_revision },
      );
    }
    let transformation: Transformation;
    try {
      transformation = parseTransformation(input.transformation);
    } catch (error) {
      throw new TransformationRepositoryError(
        "Transformation commit contains an invalid snapshot",
        "invalid_request",
        { operation: "commit", phase: "validate_input" },
        { cause: error },
      );
    }
    if (transformation.revision !== input.expected_revision + 1) {
      throw new TransformationRepositoryError(
        `Transformation candidate revision ${transformation.revision} does not follow expected base ${input.expected_revision}`,
        "invalid_request",
        {
          operation: "commit",
          phase: "validate_input",
          transformation_id: transformation.id,
          revision: transformation.revision,
          expected_revision: input.expected_revision,
        },
      );
    }
    const idempotencyKey = input.idempotency_key?.trim();
    if (input.idempotency_key !== undefined && !idempotencyKey) {
      throw new TransformationRepositoryError(
        "Transformation commit contains an empty idempotency_key",
        "invalid_request",
        { operation: "commit", phase: "validate_input", transformation_id: transformation.id },
      );
    }
    const fingerprint = canonicalJson(transformation);
    const transaction: TransactionContext = {
      id: randomUUID(),
      operation: "transformation_commit",
      phase: "begin",
      transformationId: transformation.id,
    };
    return this.withTransaction(transaction, () => {
      if (idempotencyKey) {
        transaction.phase = "check_idempotency";
        const replay = this.db.prepare(`
          select request_fingerprint, transformation_id, revision
          from transformation_idempotency_v1 where idempotency_key = ?
        `).get(idempotencyKey) as IdempotencyRow | undefined;
        if (replay) {
          if (replay.request_fingerprint !== fingerprint) {
            throw this.problem(
              "idempotency_conflict",
              `Transformation idempotency key ${idempotencyKey} was reused with different content`,
              transaction,
              { idempotency_key: idempotencyKey },
            );
          }
          const stored = this.mustRead({
            transformation_id: replay.transformation_id,
            revision: Number(replay.revision),
          });
          return { transformation: stored, created: false, transaction_id: transaction.id };
        }
      }

      transaction.phase = "compare_head";
      const head = this.db.prepare(`
        select revision from transformation_heads_v1 where transformation_id = ?
      `).get(transformation.id) as HeadRow | undefined;
      const actualRevision = head ? Number(head.revision) : 0;
      if (actualRevision !== input.expected_revision) {
        throw this.problem(
          "conflict",
          `Transformation revision conflict for ${transformation.id}: expected ${input.expected_revision}, found ${actualRevision}`,
          transaction,
          { expected_revision: input.expected_revision, actual_revision: actualRevision },
        );
      }
      if (actualRevision > 0) {
        const previous = this.mustRead({ transformation_id: transformation.id, revision: actualRevision });
        try {
          assertTransformationRevisionTransition(previous, transformation);
        } catch (error) {
          throw this.problem("conflict", error instanceof Error ? error.message : String(error), transaction, {}, error);
        }
      }

      transaction.phase = "persist_revision";
      this.db.prepare(`
        insert into transformation_revisions_v1 (
          transformation_id, revision, created_at, transformation_json
        ) values (?, ?, ?, ?)
      `).run(transformation.id, transformation.revision, transformation.created_at, JSON.stringify(transformation));
      if (actualRevision === 0) {
        this.db.prepare(`
          insert into transformation_heads_v1 (transformation_id, revision, updated_at)
          values (?, ?, ?)
        `).run(transformation.id, transformation.revision, transformation.created_at);
      } else {
        const changed = this.db.prepare(`
          update transformation_heads_v1 set revision = ?, updated_at = ?
          where transformation_id = ? and revision = ?
        `).run(transformation.revision, transformation.created_at, transformation.id, actualRevision);
        if (Number(changed.changes) !== 1) {
          throw this.problem("conflict", `Atomic Transformation head update failed for ${transformation.id}`, transaction);
        }
      }
      if (idempotencyKey) {
        this.db.prepare(`
          insert into transformation_idempotency_v1 (
            idempotency_key, request_fingerprint, transformation_id, revision, created_at
          ) values (?, ?, ?, ?, ?)
        `).run(idempotencyKey, fingerprint, transformation.id, transformation.revision, transformation.created_at);
      }
      return { transformation, created: true, transaction_id: transaction.id };
    });
  }

  async get(ref: ExactTransformationRef): Promise<Transformation | undefined> {
    const exact = exactTransformationRef(ref);
    return this.read("transformation_get", () => this.tryRead(exact));
  }

  async getLatest(transformationId: string): Promise<Transformation | undefined> {
    const id = transformationId.trim();
    if (!id) {
      throw new TransformationRepositoryError(
        "transformationId is required",
        "invalid_request",
        { operation: "transformation_get_latest", phase: "validate_input" },
      );
    }
    return this.read("transformation_get_latest", () => {
      const head = this.db.prepare(`
        select revision from transformation_heads_v1 where transformation_id = ?
      `).get(id) as HeadRow | undefined;
      return head ? this.mustRead({ transformation_id: id, revision: Number(head.revision) }) : undefined;
    });
  }

  close(): void {
    this.db.close();
  }

  private tryRead(ref: ExactTransformationRef): Transformation | undefined {
    const row = this.db.prepare(`
      select transformation_json from transformation_revisions_v1
      where transformation_id = ? and revision = ?
    `).get(ref.transformation_id, ref.revision) as RevisionRow | undefined;
    if (!row) return undefined;
    try {
      return parseTransformation(JSON.parse(row.transformation_json));
    } catch (error) {
      throw new TransformationRepositoryError(
        `Stored Transformation ${ref.transformation_id}@${ref.revision} failed validation`,
        "corrupt_data",
        {
          operation: "transformation_read",
          phase: "parse",
          transformation_id: ref.transformation_id,
          revision: ref.revision,
        },
        { cause: error },
      );
    }
  }

  private mustRead(ref: ExactTransformationRef): Transformation {
    const transformation = this.tryRead(ref);
    if (!transformation) {
      throw new TransformationRepositoryError(
        `Stored Transformation ${ref.transformation_id}@${ref.revision} is missing`,
        "corrupt_data",
        {
          operation: "transformation_read",
          phase: "read",
          transformation_id: ref.transformation_id,
          revision: ref.revision,
        },
      );
    }
    return transformation;
  }

  private migrate(): void {
    const transaction: TransactionContext = { id: randomUUID(), operation: "transformation_migrate", phase: "begin" };
    this.withTransaction(transaction, () => {
      transaction.phase = "create_schema";
      this.db.exec(`
        create table if not exists transformation_revisions_v1 (
          transformation_id text not null,
          revision integer not null check(revision > 0),
          created_at text not null,
          transformation_json text not null,
          primary key (transformation_id, revision)
        );
        create table if not exists transformation_heads_v1 (
          transformation_id text primary key,
          revision integer not null check(revision > 0),
          updated_at text not null,
          foreign key (transformation_id, revision)
            references transformation_revisions_v1(transformation_id, revision)
            deferrable initially deferred
        );
        create table if not exists transformation_idempotency_v1 (
          idempotency_key text primary key,
          request_fingerprint text not null,
          transformation_id text not null,
          revision integer not null check(revision > 0),
          created_at text not null,
          foreign key (transformation_id, revision)
            references transformation_revisions_v1(transformation_id, revision)
            deferrable initially deferred
        );
        create table if not exists transformation_schema_versions_v1 (
          component text primary key check(component = 'transformation-repository'),
          version integer not null check(version > 0),
          migrated_at text not null
        );
        create index if not exists idx_transformation_revisions_created_v1
          on transformation_revisions_v1(created_at);
      `);
      const stored = this.db.prepare(`
        select version from transformation_schema_versions_v1
        where component = 'transformation-repository'
      `).get() as VersionRow | undefined;
      const version = stored ? Number(stored.version) : 0;
      if (version > SCHEMA_VERSION) {
        throw this.problem(
          "storage_failure",
          `Transformation Repository schema ${version} is newer than supported ${SCHEMA_VERSION}`,
          transaction,
        );
      }
      if (version < SCHEMA_VERSION) {
        transaction.phase = "record_version";
        this.db.prepare(`
          insert into transformation_schema_versions_v1 (component, version, migrated_at)
          values ('transformation-repository', ?, ?)
          on conflict(component) do update set version = excluded.version, migrated_at = excluded.migrated_at
        `).run(SCHEMA_VERSION, new Date().toISOString());
      }
      transaction.phase = "foreign_key_check";
      const violation = this.db.prepare("pragma foreign_key_check").get() as { table: string } | undefined;
      if (violation) {
        throw this.problem("corrupt_data", `Transformation Repository foreign key violation in ${violation.table}`, transaction);
      }
    });
  }

  private read<T>(operation: string, fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof TransformationRepositoryError) throw error;
      throw new TransformationRepositoryError(
        `SQLite Transformation Repository ${operation} failed`,
        "storage_failure",
        { operation, phase: "read", sqlite_code: sqliteCode(error) },
        { cause: error },
      );
    }
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
      if (error instanceof TransformationRepositoryError && !rollbackError) {
        if (error.details.transaction_id) throw error;
        throw new TransformationRepositoryError(
          error.message,
          error.code,
          {
            ...error.details,
            operation: transaction.operation,
            phase: transaction.phase,
            transaction_id: transaction.id,
            transformation_id: transaction.transformationId ?? error.details.transformation_id,
          },
          { cause: error },
        );
      }
      const cause = rollbackError
        ? new AggregateError([error, rollbackError], "Transformation operation and rollback both failed")
        : error;
      throw new TransformationRepositoryError(
        `SQLite Transformation Repository ${transaction.operation} failed during ${transaction.phase}`,
        "storage_failure",
        {
          operation: transaction.operation,
          phase: transaction.phase,
          transaction_id: transaction.id,
          transformation_id: transaction.transformationId,
          sqlite_code: sqliteCode(error),
        },
        { cause },
      );
    }
  }

  private problem(
    code: TransformationRepositoryErrorCode,
    message: string,
    transaction: TransactionContext,
    extra: Partial<TransformationRepositoryError["details"]> = {},
    cause?: unknown,
  ): TransformationRepositoryError {
    return new TransformationRepositoryError(
      message,
      code,
      {
        operation: transaction.operation,
        phase: transaction.phase,
        transaction_id: transaction.id,
        transformation_id: transaction.transformationId,
        ...extra,
      },
      cause === undefined ? undefined : { cause },
    );
  }
}

function sqliteCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
