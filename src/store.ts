import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ContextArtifact, ContextConnector, ContextPackRequest, ContextQuery, ContextRecord, ContextSchema, ContextView, RuntimeState, StoredContextConnector, StoredContextRecord, StoredContextView, StoredWorkThread, WorkThread } from "./types.js";

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

  insertRecord(record: ContextRecord): StoredContextRecord {
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

  insertArtifact(artifact: ContextArtifact): ContextArtifact & { id: string; created_at: string } {
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

  registerSchema(schema: ContextSchema): ContextSchema & { created_at: string } {
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
    return stored;
  }

  getView(id: string): StoredContextView | undefined {
    const row = this.db.prepare(`select * from context_views where id = ?`).get(id) as any;
    return row ? rowToView(row) : undefined;
  }

  listViews(options: { view_types?: string[]; limit?: number; scope?: ContextRecord["scope"]; timeWindow?: ContextPackRequest["time_window"] } = {}): StoredContextView[] {
    const limit = options.limit ?? 50;
    const rows = this.db.prepare(`select * from context_views order by updated_at desc limit ?`).all(Math.max(limit * 8, limit)) as any[];
    return rows
      .map(rowToView)
      .filter(view => !options.view_types?.length || options.view_types.includes(view.view_type))
      .filter(view => scopeMatches({ scope: view.scope } as StoredContextRecord, options.scope))
      .filter(view => viewTimeMatches(view, options.timeWindow))
      .slice(0, limit);
  }

  queryRecords(query: ContextQuery): StoredContextRecord[] {
    const limit = query.limit ?? 40;
    const timeWindow = normalizeTimeWindow(query.time_window);
    let records: StoredContextRecord[];
    if (query.mode === "thread" && query.thread_id) records = this.recordsForThread(query.thread_id, limit);
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

  recent(limit = 50, scope?: ContextRecord["scope"], timeWindow?: ContextPackRequest["time_window"]): StoredContextRecord[] {
    const all = this.db.prepare(`select * from context_records order by created_at desc limit ?`).all(Math.max(limit * 8, limit)) as any[];
    return all.map(rowToRecord).filter(r => scopeMatches(r, scope)).filter(r => timeMatches(r, timeWindow)).slice(0, limit);
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
    const recent = this.recent(Math.ceil(limit / 2), req.scope, timeWindow);
    const relevant = this.search(req.goal, limit, req.scope, timeWindow);
    const threadRecords = req.thread_id ? this.recordsForThread(req.thread_id, limit) : [];
    const byId = new Map<string, StoredContextRecord>();
    for (const item of [...threadRecords, ...relevant, ...recent, ...extraRecords]) byId.set(item.id, item);
    const records = [...byId.values()]
      .sort((a, b) => Date.parse(b.time?.observed_at ?? b.created_at) - Date.parse(a.time?.observed_at ?? a.created_at))
      .slice(0, limit);
    return {
      version: 2,
      goal: req.goal,
      scope: req.scope ?? {},
      thread_id: req.thread_id,
      thread: req.thread_id ? this.getWorkThread(req.thread_id) : undefined,
      time_window: timeWindow,
      generated_at: new Date().toISOString(),
      records,
      diagnostics,
      markdown: renderContextPack(req.goal, records, req.token_budget ?? 6000, diagnostics, timeWindow),
      sources: records.map(r => ({
        id: r.id,
        schema: r.schema,
        source: r.source,
        url: r.content?.url,
        path: r.content?.path,
        observed_at: r.time?.observed_at,
        created_at: r.created_at,
      })),
    };
  }
}

function normalizeTimeWindow(timeWindow?: ContextPackRequest["time_window"]): ContextPackRequest["time_window"] | undefined {
  if (!timeWindow) return undefined;
  const end = timeWindow.end_time ?? new Date().toISOString();
  const start = timeWindow.start_time ?? (timeWindow.minutes ? new Date(Date.parse(end) - timeWindow.minutes * 60_000).toISOString() : undefined);
  return { start_time: start, end_time: end, minutes: timeWindow.minutes };
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
  for (const key of ["project", "repo", "app", "domain", "session"] as const) {
    if (scope[key] && record.scope?.[key] !== scope[key]) return false;
  }
  return true;
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
    source_records: parseJson(row.source_records_json, []),
    source_views: parseJson(row.source_views_json, []),
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

function rowToRuntimeState(row: any): RuntimeState {
  return {
    key: row.key,
    value: parseJson(row.value_json, {}),
    updated_at: row.updated_at,
  };
}

function renderContextPack(goal: string, records: StoredContextRecord[], tokenBudget: number, diagnostics: Record<string, unknown> = {}, timeWindow?: ContextPackRequest["time_window"]): string {
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

  return parts.filter(Boolean).join("\n");
}
