import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { activeContextView } from "./view-lifecycle.js";
import { filterViewsByQuery } from "./view-query.js";
import { rankViewsForSurfacing, surfacingPreferencesFromMemoryViews } from "./view-surfacing.js";
import type { ContextArtifact, ContextConnector, ContextPackRequest, ContextQuery, ContextRecord, ContextSchema, ContextView, RuntimeEvent, RuntimeState, StoredContextArtifact, StoredContextConnector, StoredContextRecord, StoredContextSchema, StoredContextView, StoredRuntimeEvent, StoredWorkThread, WorkThread } from "./types.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseJsonStringArray(value: string | null | undefined): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function likeEscape(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export class ContextStore {
  private db: DatabaseSync;

  constructor(dbPath = process.env.CONTEXT_DB_PATH ?? "data/context.sqlite") {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      create table if not exists context_records (
        id text primary key,
        schema_name text not null,
        schema_version integer not null,
        source_type text not null,
        source_id text,
        connector text,
        scope_json text,
        time_json text,
        title text,
        text text,
        url text,
        path text,
        acquisition_json text,
        signal_json text,
        privacy_json text,
        relations_json text,
        validity_json text,
        memory_json text,
        payload_json text not null,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_context_records_created_at on context_records(created_at);
      create index if not exists idx_context_records_schema on context_records(schema_name, schema_version);
      create index if not exists idx_context_records_source on context_records(source_type);
      create index if not exists idx_context_records_url on context_records(url);
      create index if not exists idx_context_records_path on context_records(path);

      create table if not exists context_artifacts (
        id text primary key,
        record_id text not null,
        kind text not null,
        mime_type text,
        uri text not null,
        sha256 text,
        size_bytes integer,
        metadata_json text,
        created_at text not null,
        foreign key(record_id) references context_records(id)
      );

      create index if not exists idx_context_artifacts_record on context_artifacts(record_id);

      create table if not exists context_schemas (
        name text not null,
        version integer not null,
        description text,
        json_schema text,
        example_json text,
        created_at text not null,
        primary key (name, version)
      );

      create table if not exists context_connectors (
        id text primary key,
        name text not null,
        type text not null,
        version integer,
        description text,
        schemas_produced_json text,
        default_scope_json text,
        default_privacy_json text,
        permissions_json text,
        config_json text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists work_threads (
        id text primary key,
        title text not null,
        status text not null,
        confidence real,
        evidence_records_json text,
        keywords_json text,
        domains_json text,
        apps_json text,
        projects_json text,
        repos_json text,
        reasons_json text,
        metadata_json text,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_work_threads_status on work_threads(status);

      create table if not exists context_views (
        id text primary key,
        view_type text not null,
        title text,
        summary text,
        status text,
        source_records_json text,
        source_views_json text,
        compiler_json text,
        purpose text,
        scope_json text,
        content_json text,
        confidence real,
        stability text,
        lossiness text,
        privacy_json text,
        validity_json text,
        metadata_json text,
        created_at text not null,
        updated_at text not null
      );

      create index if not exists idx_context_views_type on context_views(view_type);
      create index if not exists idx_context_views_status on context_views(status);
      create index if not exists idx_context_views_updated_at on context_views(updated_at);

      create table if not exists runtime_state (
        key text primary key,
        value_json text not null,
        updated_at text not null
      );

      create table if not exists runtime_events (
        id text primary key,
        event_type text not null,
        actor text not null,
        status text,
        subject_type text,
        subject_id text,
        plugin_id text,
        related_records_json text,
        related_views_json text,
        related_threads_json text,
        payload_json text,
        created_at text not null
      );

      create index if not exists idx_runtime_events_created_at on runtime_events(created_at);
      create index if not exists idx_runtime_events_type on runtime_events(event_type);
      create index if not exists idx_runtime_events_plugin on runtime_events(plugin_id);
    `);
    this.ensureColumn("context_records", "relations_json", "text");
    this.ensureColumn("context_records", "validity_json", "text");
    this.ensureColumn("context_records", "memory_json", "text");
  }

  private ensureColumn(table: string, column: string, type: string) {
    const rows = this.db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
    if (!rows.some(row => row.name === column)) {
      this.db.exec(`alter table ${table} add column ${column} ${type}`);
    }
  }

  withConnectorDefaults(record: ContextRecord): ContextRecord {
    const connectorId = record.source.connector;
    if (!connectorId) return record;
    const connector = this.getConnector(connectorId);
    if (!connector) return record;
    return {
      ...record,
      scope: { ...connector.default_scope, ...record.scope },
      privacy: { ...connector.default_privacy, ...record.privacy },
    };
  }

  insertRecord(record: ContextRecord): StoredContextRecord {
    record = this.withConnectorDefaults(record);
    const now = new Date().toISOString();
    const id = record.id ?? randomUUID();
    const time = {
      observed_at: record.time?.observed_at ?? now,
      captured_at: record.time?.captured_at ?? now,
    };
    const normalized: StoredContextRecord = {
      ...record,
      id,
      time,
      payload: record.payload ?? {},
      created_at: now,
      updated_at: now,
    };

    this.db.prepare(`
      insert into context_records (
        id, schema_name, schema_version, source_type, source_id, connector,
        scope_json, time_json, title, text, url, path,
        acquisition_json, signal_json, privacy_json, relations_json, validity_json, memory_json, payload_json,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        schema_name = excluded.schema_name,
        schema_version = excluded.schema_version,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        connector = excluded.connector,
        scope_json = excluded.scope_json,
        time_json = excluded.time_json,
        title = excluded.title,
        text = excluded.text,
        url = excluded.url,
        path = excluded.path,
        acquisition_json = excluded.acquisition_json,
        signal_json = excluded.signal_json,
        privacy_json = excluded.privacy_json,
        relations_json = excluded.relations_json,
        validity_json = excluded.validity_json,
        memory_json = excluded.memory_json,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      record.schema.name,
      record.schema.version,
      record.source.type,
      record.source.id ?? null,
      record.source.connector ?? null,
      json(record.scope),
      json(time),
      record.content?.title ?? null,
      record.content?.text ?? null,
      record.content?.url ?? null,
      record.content?.path ?? null,
      json(record.acquisition),
      json(record.signal),
      json(record.privacy),
      json(record.relations),
      json(record.validity),
      json(record.memory),
      json(record.payload),
      now,
      now,
    );

    return normalized;
  }

  insertRecordWithDedupe(record: ContextRecord): { record?: StoredContextRecord; deduped?: boolean; duplicate_of?: string; reason?: string } {
    const duplicate = this.findRecentDuplicateSnapshot(record);
    if (duplicate) {
      return {
        record: duplicate,
        deduped: true,
        duplicate_of: duplicate.id,
        reason: "duplicate browser snapshot within dedupe window",
      };
    }
    return { record: this.insertRecord(withContentFingerprint(record)), deduped: false };
  }

  private findRecentDuplicateSnapshot(record: ContextRecord): StoredContextRecord | undefined {
    if (!isDedupeCandidate(record)) return undefined;
    const url = record.content?.url;
    if (!url) return undefined;
    const fingerprint = contentFingerprint(record.content?.text);
    if (!fingerprint) return undefined;
    const windowSeconds = Number(record.payload?.dedupe_window_seconds ?? process.env.CONTEXT_SNAPSHOT_DEDUPE_SECONDS ?? 120);
    const windowStart = new Date(Date.now() - Math.max(0, windowSeconds) * 1000).toISOString();
    const rows = this.db.prepare(`
      select * from context_records
      where schema_name = ?
        and url = ?
        and created_at >= ?
      order by created_at desc
      limit 20
    `).all(record.schema.name, url, windowStart) as any[];
    return rows.map(rowToRecord).find(existing => existing.payload?.content_fingerprint === fingerprint);
  }

  insertArtifact(artifact: ContextArtifact): StoredContextArtifact {
    const id = artifact.id ?? randomUUID();
    const created_at = new Date().toISOString();
    this.db.prepare(`
      insert into context_artifacts (
        id, record_id, kind, mime_type, uri, sha256, size_bytes, metadata_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      artifact.record_id,
      artifact.kind,
      artifact.mime_type ?? null,
      artifact.uri,
      artifact.sha256 ?? null,
      artifact.size_bytes ?? null,
      json(artifact.metadata),
      created_at,
    );
    return { ...artifact, id, created_at };
  }

  getArtifact(id: string): StoredContextArtifact | undefined {
    const row = this.db.prepare(`select * from context_artifacts where id = ?`).get(id) as any;
    return row ? rowToArtifact(row) : undefined;
  }

  listArtifacts(options: { record_id?: string; limit?: number } = {}): StoredContextArtifact[] {
    const limit = options.limit ?? 50;
    const rows = options.record_id
      ? this.db.prepare(`select * from context_artifacts where record_id = ? order by created_at desc limit ?`).all(options.record_id, limit) as any[]
      : this.db.prepare(`select * from context_artifacts order by created_at desc limit ?`).all(limit) as any[];
    return rows.map(rowToArtifact);
  }

  registerSchema(schema: ContextSchema): StoredContextSchema {
    const created_at = new Date().toISOString();
    this.db.prepare(`
      insert or replace into context_schemas (
        name, version, description, json_schema, example_json, created_at
      ) values (?, ?, ?, ?, ?, ?)
    `).run(
      schema.name,
      schema.version,
      schema.description ?? null,
      json(schema.json_schema),
      json(schema.example),
      created_at,
    );
    return { ...schema, created_at };
  }

  listSchemas(options: { name?: string; version?: number; limit?: number } = {}): StoredContextSchema[] {
    const limit = options.limit ?? 100;
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    if (options.name) {
      clauses.push("name = ?");
      args.push(options.name);
    }
    if (options.version) {
      clauses.push("version = ?");
      args.push(options.version);
    }
    args.push(limit);
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db.prepare(`select * from context_schemas ${where} order by name asc, version desc limit ?`).all(...args) as any[];
    return rows.map(rowToSchema);
  }

  registerConnector(connector: ContextConnector): StoredContextConnector {
    const now = new Date().toISOString();
    const existing = this.getConnector(connector.id);
    const created_at = existing?.created_at ?? now;
    const stored: StoredContextConnector = {
      ...connector,
      created_at,
      updated_at: now,
    };
    this.db.prepare(`
      insert into context_connectors (
        id, name, type, version, description, schemas_produced_json,
        default_scope_json, default_privacy_json, permissions_json, config_json,
        created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        type = excluded.type,
        version = excluded.version,
        description = excluded.description,
        schemas_produced_json = excluded.schemas_produced_json,
        default_scope_json = excluded.default_scope_json,
        default_privacy_json = excluded.default_privacy_json,
        permissions_json = excluded.permissions_json,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(
      connector.id,
      connector.name,
      connector.type,
      connector.version ?? null,
      connector.description ?? null,
      json(connector.schemas_produced),
      json(connector.default_scope),
      json(connector.default_privacy),
      json(connector.permissions),
      json(connector.config),
      created_at,
      now,
    );
    return stored;
  }

  listConnectors(): StoredContextConnector[] {
    const rows = this.db.prepare(`select * from context_connectors order by updated_at desc`).all() as any[];
    return rows.map(rowToConnector);
  }

  getConnector(id: string): StoredContextConnector | undefined {
    const row = this.db.prepare(`select * from context_connectors where id = ?`).get(id) as any;
    return row ? rowToConnector(row) : undefined;
  }


  upsertView(view: ContextView): StoredContextView {
    const now = new Date().toISOString();
    const id = view.id ?? randomUUID();
    const existing = this.getView(id);
    const created_at = existing?.created_at ?? now;
    const stored: StoredContextView = {
      ...view,
      id,
      status: view.status ?? "candidate",
      content: view.content ?? {},
      metadata: view.metadata ?? {},
      created_at,
      updated_at: now,
    };
    this.db.prepare(`
      insert into context_views (
        id, view_type, title, summary, status, source_records_json, source_views_json,
        compiler_json, purpose, scope_json, content_json, confidence, stability,
        lossiness, privacy_json, validity_json, metadata_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        view_type = excluded.view_type,
        title = excluded.title,
        summary = excluded.summary,
        status = excluded.status,
        source_records_json = excluded.source_records_json,
        source_views_json = excluded.source_views_json,
        compiler_json = excluded.compiler_json,
        purpose = excluded.purpose,
        scope_json = excluded.scope_json,
        content_json = excluded.content_json,
        confidence = excluded.confidence,
        stability = excluded.stability,
        lossiness = excluded.lossiness,
        privacy_json = excluded.privacy_json,
        validity_json = excluded.validity_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      stored.view_type,
      stored.title ?? null,
      stored.summary ?? null,
      stored.status ?? null,
      JSON.stringify(stored.source_records ?? []),
      JSON.stringify(stored.source_views ?? []),
      json(stored.compiler),
      stored.purpose ?? null,
      json(stored.scope),
      json(stored.content),
      stored.confidence ?? null,
      stored.stability ?? null,
      stored.lossiness ?? null,
      json(stored.privacy),
      json(stored.validity),
      json(stored.metadata),
      created_at,
      now,
    );
    this.appendRuntimeEvent({
      event_type: "view_upserted",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      related_records: stored.source_records,
      related_views: stored.source_views,
      plugin_id: stored.scope?.plugin_id,
      payload: { view_type: stored.view_type, title: stored.title, confidence: stored.confidence },
    });
    return stored;
  }

  getView(id: string): StoredContextView | undefined {
    const row = this.db.prepare(`select * from context_views where id = ?`).get(id) as any;
    return row ? rowToView(row) : undefined;
  }

  listViewFamilySummaries(options: { view_types?: string[]; active_only?: boolean } = {}): Array<{ family: string; count: number; latest?: StoredContextView; kinds: string[] }> {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.view_types?.length) {
      clauses.push(`view_type in (${options.view_types.map(() => "?").join(", ")})`);
      params.push(...options.view_types);
    }
    if (options.active_only) clauses.push(`(status is null or status not in ('archived', 'rejected'))`);
    const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
    const rows = this.db.prepare(`select view_type as family, count(*) as count, max(updated_at) as latest_updated_at from context_views${where} group by view_type`).all(...params) as Array<{ family: string; count: number; latest_updated_at?: string }>;
    return rows.map(row => {
      const latest = this.db.prepare(`select * from context_views where view_type = ?${options.active_only ? " and (status is null or status not in ('archived', 'rejected'))" : ""} order by updated_at desc limit 1`).get(row.family) as any;
      const kindRows = this.db.prepare(`select content_json from context_views where view_type = ?${options.active_only ? " and (status is null or status not in ('archived', 'rejected'))" : ""} order by updated_at desc limit 200`).all(row.family) as Array<{ content_json?: string }>;
      const kinds = [...new Set(kindRows
        .map(kindRow => parseJson<Record<string, unknown>>(kindRow.content_json, {}))
        .map(content => typeof content.kind === "string" ? content.kind : undefined)
        .filter((value): value is string => Boolean(value)))]
        .slice(0, 12);
      return {
        family: row.family,
        count: Number(row.count ?? 0),
        latest: latest ? rowToView(latest) : undefined,
        kinds,
      };
    });
  }

  listViews(options: {
    view_types?: string[];
    view_type_prefix?: string;
    limit?: number;
    scope?: ContextRecord["scope"];
    timeWindow?: ContextPackRequest["time_window"];
    active_only?: boolean;
    status?: ContextView["status"];
    compiler_id?: string;
    source_record_id?: string;
    source_view_id?: string;
    updated_after?: string;
  } = {}): StoredContextView[] {
    const limit = options.limit ?? 50;
    const unbounded = options.limit !== undefined && options.limit <= 0;
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.view_types?.length) {
      clauses.push(`view_type in (${options.view_types.map(() => "?").join(", ")})`);
      params.push(...options.view_types);
    }
    if (options.view_type_prefix) {
      clauses.push(`view_type like ?`);
      params.push(`${options.view_type_prefix}%`);
    }
    if (options.status) {
      clauses.push(`status = ?`);
      params.push(options.status);
    } else if (options.active_only) {
      clauses.push(`(status is null or status not in ('archived', 'rejected'))`);
    }
    if (options.updated_after) {
      clauses.push(`updated_at > ?`);
      params.push(options.updated_after);
    }
    const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
    const sql = `select * from context_views${where} order by updated_at desc${unbounded ? "" : " limit ?"}`;
    if (!unbounded) params.push(Math.max(limit * 8, limit));
    const rows = this.db.prepare(sql).all(...params) as any[];
    const filtered = rows
      .map(rowToView)
      .filter(view => !options.view_types?.length || options.view_types.includes(view.view_type))
      .filter(view => !options.view_type_prefix || view.view_type.startsWith(options.view_type_prefix))
      .filter(view => !options.active_only || activeContextView(view))
      .filter(view => !options.status || view.status === options.status)
      .filter(view => !options.compiler_id || view.compiler?.id === options.compiler_id)
      .filter(view => !options.source_record_id || view.source_records?.includes(options.source_record_id))
      .filter(view => !options.source_view_id || view.source_views?.includes(options.source_view_id))
      .filter(view => !options.updated_after || Date.parse(view.updated_at) > Date.parse(options.updated_after))
      .filter(view => scopeMatches({ scope: view.scope } as StoredContextRecord, options.scope))
      .filter(view => viewTimeMatches(view, options.timeWindow));
    return unbounded ? filtered : filtered.slice(0, limit);
  }

  queryRecords(query: ContextQuery): StoredContextRecord[] {
    const limit = query.limit ?? 40;
    const timeWindow = normalizeTimeWindow(query.time_window);
    let records: StoredContextRecord[];
    if (query.mode === "thread" && query.thread_id) records = this.recordsForThread(query.thread_id, limit);
    else if (query.mode === "source") records = this.recent(limit, query.scope, timeWindow);
    else if (query.query || query.goal) records = this.search(query.query ?? query.goal ?? "", limit, query.scope, timeWindow);
    else records = this.recent(limit, query.scope, timeWindow);
    return records
      .filter(record => !query.schemas?.length || query.schemas.includes(record.schema.name))
      .filter(record => !query.sources?.length || query.sources.includes(record.source.type) || (record.source.connector ? query.sources.includes(record.source.connector) : false))
      .slice(0, limit);
  }

  upsertWorkThread(thread: WorkThread): StoredWorkThread {
    const now = new Date().toISOString();
    const existing = this.getWorkThread(thread.id);
    const created_at = existing?.created_at ?? now;
    const stored: StoredWorkThread = { ...thread, created_at, updated_at: now };
    this.db.prepare(`
      insert into work_threads (
        id, title, status, confidence, evidence_records_json, keywords_json, domains_json,
        apps_json, projects_json, repos_json, reasons_json, metadata_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        title = excluded.title,
        status = excluded.status,
        confidence = excluded.confidence,
        evidence_records_json = excluded.evidence_records_json,
        keywords_json = excluded.keywords_json,
        domains_json = excluded.domains_json,
        apps_json = excluded.apps_json,
        projects_json = excluded.projects_json,
        repos_json = excluded.repos_json,
        reasons_json = excluded.reasons_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      thread.id,
      thread.title,
      thread.status,
      thread.confidence ?? null,
      json(thread.evidence_records),
      json(thread.keywords),
      json(thread.domains),
      json(thread.apps),
      json(thread.projects),
      json(thread.repos),
      json(thread.reasons),
      json(thread.metadata),
      created_at,
      now,
    );
    return stored;
  }

  listWorkThreads(status?: WorkThread["status"]): StoredWorkThread[] {
    const rows = status
      ? this.db.prepare(`select * from work_threads where status = ? order by updated_at desc`).all(status) as any[]
      : this.db.prepare(`select * from work_threads order by updated_at desc`).all() as any[];
    return rows.map(rowToWorkThread);
  }

  getWorkThread(id: string): StoredWorkThread | undefined {
    const row = this.db.prepare(`select * from work_threads where id = ?`).get(id) as any;
    return row ? rowToWorkThread(row) : undefined;
  }

  updateWorkThreadStatus(id: string, status: WorkThread["status"], title?: string): StoredWorkThread | undefined {
    const thread = this.getWorkThread(id);
    if (!thread) return undefined;
    return this.upsertWorkThread({ ...thread, status, title: title ?? thread.title });
  }


  appendRuntimeEvent(event: RuntimeEvent): StoredRuntimeEvent {
    const created_at = new Date().toISOString();
    const id = event.id ?? randomUUID();
    const stored: StoredRuntimeEvent = { ...event, id, payload: event.payload ?? {}, created_at };
    this.db.prepare(`
      insert into runtime_events (
        id, event_type, actor, status, subject_type, subject_id, plugin_id,
        related_records_json, related_views_json, related_threads_json, payload_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      stored.event_type,
      stored.actor,
      stored.status ?? null,
      stored.subject_type ?? null,
      stored.subject_id ?? null,
      stored.plugin_id ?? null,
      JSON.stringify(stored.related_records ?? []),
      JSON.stringify(stored.related_views ?? []),
      JSON.stringify(stored.related_threads ?? []),
      json(stored.payload),
      created_at,
    );
    return stored;
  }

  listRuntimeEvents(options: {
    limit?: number;
    event_type?: string;
    event_types?: string[];
    plugin_id?: string;
    subject_type?: string;
    subject_id?: string;
    actor?: RuntimeEvent["actor"];
    actor_types?: RuntimeEvent["actor"][];
    timeWindow?: ContextPackRequest["time_window"];
  } = {}): StoredRuntimeEvent[] {
    const limit = options.limit ?? 50;
    const normalizedWindow = normalizeTimeWindow(options.timeWindow);
    const clauses: string[] = [];
    const args: Array<string | number> = [];
    const eventTypes = options.event_types?.length ? options.event_types : options.event_type ? [options.event_type] : [];
    if (eventTypes.length) {
      clauses.push(`event_type in (${eventTypes.map(() => "?").join(",")})`);
      args.push(...eventTypes);
    }
    if (options.plugin_id) {
      clauses.push("plugin_id = ?");
      args.push(options.plugin_id);
    }
    if (options.subject_type) {
      clauses.push("subject_type = ?");
      args.push(options.subject_type);
    }
    if (options.subject_id) {
      clauses.push("subject_id = ?");
      args.push(options.subject_id);
    }
    const actorTypes = options.actor_types?.length ? options.actor_types : options.actor ? [options.actor] : [];
    if (actorTypes.length) {
      clauses.push(`actor in (${actorTypes.map(() => "?").join(",")})`);
      args.push(...actorTypes);
    }
    if (normalizedWindow?.start_time) {
      clauses.push("created_at >= ?");
      args.push(normalizedWindow.start_time);
    }
    if (normalizedWindow?.end_time) {
      clauses.push("created_at <= ?");
      args.push(normalizedWindow.end_time);
    }
    args.push(limit);
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const rows = this.db.prepare(`select * from runtime_events ${where} order by created_at desc limit ?`).all(...args) as any[];
    return rows.map(rowToRuntimeEvent);
  }

  setRuntimeState(key: string, value: Record<string, unknown>): RuntimeState {
    const updated_at = new Date().toISOString();
    this.db.prepare(`
      insert into runtime_state (key, value_json, updated_at)
      values (?, ?, ?)
      on conflict(key) do update set
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, json(value), updated_at);
    return { key, value, updated_at };
  }

  getRuntimeState(key: string): RuntimeState | undefined {
    const row = this.db.prepare(`select * from runtime_state where key = ?`).get(key) as any;
    return row ? rowToRuntimeState(row) : undefined;
  }

  listRuntimeState(): RuntimeState[] {
    const rows = this.db.prepare(`select * from runtime_state order by updated_at desc`).all() as any[];
    return rows.map(rowToRuntimeState);
  }

  recordsForThread(threadId: string, limit = 100): StoredContextRecord[] {
    const thread = this.getWorkThread(threadId);
    if (!thread) return [];
    const ids = new Set(thread.evidence_records ?? []);
    const byId = new Map<string, StoredContextRecord>();
    for (const record of this.recent(Math.max(limit * 10, limit))) {
      if (ids.has(record.id) || record.relations?.thread_memberships?.some(m => m.thread_id === threadId)) byId.set(record.id, record);
    }
    return [...byId.values()].slice(0, limit);
  }

  getRecord(id: string): StoredContextRecord | undefined {
    const row = this.db.prepare(`select * from context_records where id = ?`).get(id) as any;
    return row ? rowToRecord(row) : undefined;
  }

  recent(limit = 50, scope?: ContextRecord["scope"], timeWindow?: ContextPackRequest["time_window"]): StoredContextRecord[] {
    const all = this.db.prepare(`select * from context_records order by created_at desc limit ?`).all(Math.max(limit * 8, limit)) as any[];
    return all.map(rowToRecord).filter(r => scopeMatches(r, scope)).filter(r => timeMatches(r, timeWindow)).slice(0, limit);
  }

  recentBySourceFilter(sourceFilter: "screenpipe" | "browser" | "runtime" | "all", limit = 50, scope?: ContextRecord["scope"], timeWindow?: ContextPackRequest["time_window"]): StoredContextRecord[] {
    if (sourceFilter === "all") return this.recent(limit, scope, timeWindow);
    const predicate = sourceFilterPredicate(sourceFilter);
    const rows = this.db.prepare(`
      select * from context_records
      where ${predicate.sql}
      order by created_at desc
      limit ?
    `).all(...predicate.params, Math.max(limit * 8, limit)) as any[];
    return rows.map(rowToRecord).filter(r => scopeMatches(r, scope)).filter(r => timeMatches(r, timeWindow)).slice(0, limit);
  }

  search(query: string, limit = 50, scope?: ContextRecord["scope"], timeWindow?: ContextPackRequest["time_window"]): StoredContextRecord[] {
    const terms = query.split(/\s+/).map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 8);
    if (terms.length === 0) return this.recent(limit, scope, timeWindow);
    const rows = this.db.prepare(`
      select * from context_records
      where title like ? escape '\\' or text like ? escape '\\' or payload_json like ? escape '\\'
      order by created_at desc
      limit ?
    `).all(likeEscape(terms[0]), likeEscape(terms[0]), likeEscape(terms[0]), Math.max(limit * 8, limit)) as any[];
    return rows
      .map(rowToRecord)
      .filter(r => scopeMatches(r, scope))
      .filter(r => timeMatches(r, timeWindow))
      .filter(r => {
        const hay = `${r.content?.title ?? ""}\n${r.content?.text ?? ""}\n${JSON.stringify(r.payload ?? {})}`.toLowerCase();
        return terms.some(t => hay.includes(t));
      })
      .slice(0, limit);
  }

  buildPack(req: ContextPackRequest, extraRecords: StoredContextRecord[] = [], diagnostics: Record<string, unknown> = {}) {
    const limit = req.limit ?? 40;
    const timeWindow = normalizeTimeWindow(req.time_window);
    const recent = this.recent(Math.ceil(limit / 2), req.scope, timeWindow).filter(isPackVisibleRecord);
    const relevant = this.search(req.goal, limit, req.scope, timeWindow).filter(isPackVisibleRecord);
    const threadRecords = req.thread_id ? this.recordsForThread(req.thread_id, limit).filter(isPackVisibleRecord) : [];
    const byId = new Map<string, StoredContextRecord>();
    for (const item of [...threadRecords, ...relevant, ...recent, ...extraRecords.filter(isPackVisibleRecord)]) byId.set(item.id, item);
    const surfacingPreferences = surfacingPreferencesFromMemoryViews(filterPackViews(this, this.listViews({ view_types: ["memory.surfacing_preference"], active_only: true, limit: 50 })));
    const listedViews = filterPackViews(this, this.listViews({
      view_types: req.view_types,
      view_type_prefix: req.view_type_prefix,
      scope: req.scope,
      timeWindow,
      active_only: true,
      limit: Math.max(limit * 3, 20),
    }));
    const matchedViews = req.include_views ? filterViewsByQuery(rankViewsForSurfacing(listedViews, surfacingPreferences), req.goal).slice(0, limit) : [];
    const views = expandSourceViews(this, matchedViews, limit);
    const provenanceRecordIds = new Set<string>();
    for (const view of views) {
      for (const recordId of view.source_records ?? []) {
        const record = this.getRecord(recordId);
        if (record) {
          provenanceRecordIds.add(record.id);
          byId.set(record.id, record);
        }
      }
    }
    const records = [...byId.values()]
      .sort((a, b) => {
        const provenanceDelta = Number(provenanceRecordIds.has(b.id)) - Number(provenanceRecordIds.has(a.id));
        if (provenanceDelta) return provenanceDelta;
        return Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at);
      })
      .slice(0, limit);
    const events = req.include_events ? this.listRuntimeEvents({
      event_types: req.event_types,
      actor_types: req.actor_types,
      limit: Math.max(limit * 3, 20),
      timeWindow,
    }).filter(event => eventProvenanceValid(this, event)).slice(0, limit) : [];
    const provenanceRecordIdList = [...provenanceRecordIds];
    const packDiagnostics = {
      ...diagnostics,
      view_count: views.length,
      event_count: events.length,
      provenance_record_count: provenanceRecordIdList.length,
      provenance_record_ids: provenanceRecordIdList,
      surfacing_preferences: surfacingPreferences,
    };
    return {
      version: 2,
      goal: req.goal,
      scope: req.scope ?? {},
      thread_id: req.thread_id,
      thread: req.thread_id ? this.getWorkThread(req.thread_id) : undefined,
      time_window: timeWindow,
      generated_at: new Date().toISOString(),
      records,
      views,
      events,
      diagnostics: packDiagnostics,
      markdown: renderContextPack(req.goal, records, views, events, req.token_budget ?? 6000, packDiagnostics, timeWindow),
      sources: [
        ...records.map(r => ({
          id: r.id,
          kind: "record" as const,
          uri: `context://records/${r.id}`,
          schema: r.schema,
          source: r.source,
          url: r.content?.url,
          path: r.content?.path,
          observed_at: r.time?.observed_at,
          created_at: r.created_at,
        })),
        ...views.map(view => ({
          id: view.id,
          kind: "view" as const,
          title: view.title,
          uri: `context://views/${view.id}`,
          created_at: view.created_at,
        })),
        ...events.map(event => ({
          id: event.id,
          kind: "event" as const,
          title: event.event_type,
          uri: `context://events/${event.id}`,
          created_at: event.created_at,
        })),
      ],
    };
  }
}


function isPackVisibleRecord(record: StoredContextRecord): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}

function filterPackViews(store: ContextStore, views: StoredContextView[]): StoredContextView[] {
  return views.filter(view => activeContextView(view) && viewProvenanceValid(store, view));
}

function viewProvenanceValid(store: ContextStore, view: StoredContextView): boolean {
  for (const id of view.source_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isPackVisibleRecord(record) || !scopeCompatible(view.scope, record.scope)) return false;
  }
  for (const id of view.source_views ?? []) {
    const sourceView = store.getView(id);
    if (!sourceView || !activeContextView(sourceView) || !scopeCompatible(view.scope, sourceView.scope)) return false;
  }
  return true;
}

function eventProvenanceValid(store: ContextStore, event: StoredRuntimeEvent): boolean {
  for (const id of event.related_records ?? []) {
    const record = store.getRecord(id);
    if (!record || !isPackVisibleRecord(record)) return false;
  }
  for (const id of event.related_views ?? []) {
    const view = store.getView(id);
    if (!view || !viewProvenanceValid(store, view)) return false;
  }
  return true;
}

function scopeCompatible(target?: ContextRecord["scope"], source?: ContextRecord["scope"]): boolean {
  if (!target || !source) return true;
  for (const key of ["project", "project_path", "repo", "domain", "app", "session"] as const) {
    if (target[key] && source[key] && target[key] !== source[key]) return false;
  }
  return true;
}

function normalizeTimeWindow(timeWindow?: ContextPackRequest["time_window"]): ContextPackRequest["time_window"] | undefined {
  if (!timeWindow) return undefined;
  const end = timeWindow.end_time ?? new Date().toISOString();
  const start = timeWindow.start_time ?? (timeWindow.minutes ? new Date(Date.parse(end) - timeWindow.minutes * 60_000).toISOString() : undefined);
  return { start_time: start, end_time: end, minutes: timeWindow.minutes };
}

function sourceFilterPredicate(sourceFilter: "screenpipe" | "browser" | "runtime"): { sql: string; params: string[] } {
  const like = `%${sourceFilter}%`;
  return {
    sql: "(source_type = ? or connector like ? or schema_name like ?)",
    params: [sourceFilter, like, like],
  };
}

function timeMatches(record: StoredContextRecord, timeWindow?: ContextPackRequest["time_window"]): boolean {
  const normalized = normalizeTimeWindow(timeWindow);
  if (!normalized?.start_time && !normalized?.end_time) return true;
  const t = Date.parse(record.time?.observed_at ?? record.created_at);
  if (Number.isNaN(t)) return true;
  if (normalized.start_time && t < Date.parse(normalized.start_time)) return false;
  if (normalized.end_time && t > Date.parse(normalized.end_time)) return false;
  return true;
}

function scopeMatches(record: StoredContextRecord, scope?: ContextRecord["scope"]): boolean {
  if (!scope) return true;
  for (const key of ["project", "project_path", "app", "session"] as const) {
    if (scope[key] && record.scope?.[key] !== scope[key]) return false;
  }
  if (scope.domain && record.scope?.domain !== scope.domain && !(scope.project_path && !record.scope?.domain)) return false;
  if (scope.repo && record.scope?.repo !== scope.repo && !(scope.project_path && !record.scope?.repo)) return false;
  return true;
}

function isDedupeCandidate(record: ContextRecord): boolean {
  if (record.schema.name !== "observation.browser_page_snapshot") return false;
  if (record.acquisition?.mode === "manual") return false;
  if (record.payload?.dedupe === false) return false;
  if (record.payload?.selected_text_length && Number(record.payload.selected_text_length) > 0) return false;
  return true;
}

function withContentFingerprint(record: ContextRecord): ContextRecord {
  if (!isDedupeCandidate(record)) return record;
  const fingerprint = contentFingerprint(record.content?.text);
  if (!fingerprint) return record;
  return {
    ...record,
    payload: {
      ...(record.payload ?? {}),
      content_fingerprint: fingerprint,
      content_text_length: normalizeTextForHash(record.content?.text).length,
    },
  };
}

function contentFingerprint(text?: string): string | undefined {
  const normalized = normalizeTextForHash(text);
  if (!normalized) return undefined;
  return createHash("sha256").update(normalized).digest("hex");
}

function normalizeTextForHash(text?: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}


function expandSourceViews(store: ContextStore, views: StoredContextView[], limit: number): StoredContextView[] {
  const byId = new Map<string, StoredContextView>();
  const visit = (view: StoredContextView, depth: number) => {
    if (byId.has(view.id) || byId.size >= limit || depth > 3) return;
    byId.set(view.id, view);
    for (const sourceViewId of view.source_views ?? []) {
      const sourceView = store.getView(sourceViewId);
      if (sourceView && activeContextView(sourceView) && viewProvenanceValid(store, sourceView)) visit(sourceView, depth + 1);
    }
  };
  for (const view of views) visit(view, 0);
  return [...byId.values()].slice(0, limit);
}

function rowToRecord(row: any): StoredContextRecord {
  return {
    id: row.id,
    schema: { name: row.schema_name, version: row.schema_version },
    source: { type: row.source_type, id: row.source_id ?? undefined, connector: row.connector ?? undefined },
    scope: parseJson(row.scope_json, {}),
    time: parseJson(row.time_json, {}),
    content: {
      title: row.title ?? undefined,
      text: row.text ?? undefined,
      url: row.url ?? undefined,
      path: row.path ?? undefined,
    },
    acquisition: parseJson(row.acquisition_json, {}),
    signal: parseJson(row.signal_json, {}),
    privacy: parseJson(row.privacy_json, {}),
    relations: parseJson(row.relations_json, {}),
    validity: parseJson(row.validity_json, {}),
    memory: parseJson(row.memory_json, {}),
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToArtifact(row: any): StoredContextArtifact {
  return {
    id: row.id,
    record_id: row.record_id,
    kind: row.kind,
    mime_type: row.mime_type ?? undefined,
    uri: row.uri,
    sha256: row.sha256 ?? undefined,
    size_bytes: row.size_bytes ?? undefined,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

function rowToSchema(row: any): StoredContextSchema {
  return {
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    json_schema: parseJson(row.json_schema, {}),
    example: parseJson(row.example_json, {}),
    created_at: row.created_at,
  };
}

function rowToConnector(row: any): StoredContextConnector {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    version: row.version ?? undefined,
    description: row.description ?? undefined,
    schemas_produced: parseJson(row.schemas_produced_json, []),
    default_scope: parseJson(row.default_scope_json, {}),
    default_privacy: parseJson(row.default_privacy_json, {}),
    permissions: parseJson(row.permissions_json, {}),
    config: parseJson(row.config_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToWorkThread(row: any): StoredWorkThread {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    confidence: row.confidence ?? undefined,
    evidence_records: parseJson(row.evidence_records_json, []),
    keywords: parseJson(row.keywords_json, []),
    domains: parseJson(row.domains_json, []),
    apps: parseJson(row.apps_json, []),
    projects: parseJson(row.projects_json, []),
    repos: parseJson(row.repos_json, []),
    reasons: parseJson(row.reasons_json, []),
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}


function rowToView(row: any): StoredContextView {
  return {
    id: row.id,
    view_type: row.view_type,
    title: row.title ?? undefined,
    summary: row.summary ?? undefined,
    status: row.status ?? undefined,
    source_records: parseJsonStringArray(row.source_records_json),
    source_views: parseJsonStringArray(row.source_views_json),
    compiler: parseJson(row.compiler_json, undefined),
    purpose: row.purpose ?? undefined,
    scope: parseJson(row.scope_json, {}),
    content: parseJson(row.content_json, {}),
    confidence: row.confidence ?? undefined,
    stability: row.stability ?? undefined,
    lossiness: row.lossiness ?? undefined,
    privacy: parseJson(row.privacy_json, {}),
    validity: parseJson(row.validity_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function viewTimeMatches(view: StoredContextView, timeWindow?: ContextPackRequest["time_window"]): boolean {
  const normalized = normalizeTimeWindow(timeWindow);
  if (!normalized?.start_time && !normalized?.end_time) return true;
  const range = view.scope?.time_range;
  const t = Date.parse(range?.end ?? range?.start ?? view.updated_at);
  if (Number.isNaN(t)) return true;
  if (normalized.start_time && t < Date.parse(normalized.start_time)) return false;
  if (normalized.end_time && t > Date.parse(normalized.end_time)) return false;
  return true;
}


function rowToRuntimeEvent(row: any): StoredRuntimeEvent {
  return {
    id: row.id,
    event_type: row.event_type,
    actor: row.actor,
    status: row.status ?? undefined,
    subject_type: row.subject_type ?? undefined,
    subject_id: row.subject_id ?? undefined,
    plugin_id: row.plugin_id ?? undefined,
    related_records: parseJsonStringArray(row.related_records_json),
    related_views: parseJsonStringArray(row.related_views_json),
    related_threads: parseJsonStringArray(row.related_threads_json),
    payload: parseJson(row.payload_json, {}),
    created_at: row.created_at,
  };
}

function rowToRuntimeState(row: any): RuntimeState {
  return {
    key: row.key,
    value: parseJson(row.value_json, {}),
    updated_at: row.updated_at,
  };
}

function renderContextPack(goal: string, records: StoredContextRecord[], views: StoredContextView[] = [], events: StoredRuntimeEvent[] = [], tokenBudget: number, diagnostics: Record<string, unknown> = {}, timeWindow?: ContextPackRequest["time_window"]): string {
  const approxChars = Math.max(1000, tokenBudget * 4);
  const parts: string[] = [
    `# Context Pack`,
    ``,
    `Goal: ${goal}`,
    timeWindow?.start_time || timeWindow?.end_time ? `Time window: ${timeWindow.start_time ?? "..."} → ${timeWindow.end_time ?? "..."}` : "",
    Object.keys(diagnostics).length ? `Diagnostics: ${JSON.stringify(diagnostics)}` : "",
    ``,
    `## Relevant Context`,
  ];

  for (const record of records) {
    const title = record.content?.title ?? record.content?.url ?? record.content?.path ?? record.schema.name;
    const text = (record.content?.text ?? JSON.stringify(record.payload ?? {})).replace(/\s+/g, " ").trim();
    const clipped = text.length > 900 ? `${text.slice(0, 900)}…` : text;
    parts.push(
      ``,
      `### ${title}`,
      `- id: ${record.id}`,
      `- schema: ${record.schema.name}@v${record.schema.version}`,
      `- source: ${record.source.type}${record.source.connector ? `/${record.source.connector}` : ""}`,
      record.content?.url ? `- url: ${record.content.url}` : "",
      record.content?.path ? `- path: ${record.content.path}` : "",
      `- time: ${record.time?.observed_at ?? record.created_at}`,
      clipped ? `\n${clipped}` : "",
    );
    if (parts.join("\n").length > approxChars) break;
  }

  if (views.length) {
    parts.push(``, `## Derived Views`);
    for (const view of views) {
      const text = `${view.summary ?? ""}\n${JSON.stringify(view.content ?? {})}`.replace(/\s+/g, " ").trim();
      const clipped = text.length > 900 ? `${text.slice(0, 900)}…` : text;
      parts.push(
        ``,
        `### ${view.title ?? view.view_type}`,
        `- id: ${view.id}`,
        `- view_type: ${view.view_type}`,
        view.status ? `- status: ${view.status}` : "",
        `- time: ${view.updated_at}`,
        clipped ? `\n${clipped}` : "",
      );
      if (parts.join("\n").length > approxChars) break;
    }
  }

  if (events.length) {
    parts.push(``, `## Runtime Events`);
    for (const event of events) {
      parts.push(
        ``,
        `### ${event.event_type}`,
        `- id: ${event.id}`,
        `- actor: ${event.actor}`,
        event.status ? `- status: ${event.status}` : "",
        event.subject_type || event.subject_id ? `- subject: ${event.subject_type ?? "unknown"}/${event.subject_id ?? "unknown"}` : "",
        `- time: ${event.created_at}`,
        Object.keys(event.payload ?? {}).length ? `\n${JSON.stringify(event.payload)}` : "",
      );
      if (parts.join("\n").length > approxChars) break;
    }
  }

  return parts.filter(Boolean).join("\n");
}
