import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getLoadablePath, load as loadSqliteVec } from "sqlite-vec";
import {
  QueryVectorSchema,
  type ExactEmbeddingProfileRef,
  type RankedSearchCandidate,
  type SearchTarget,
  type SemanticRetriever,
} from "@info/search";
import {
  ExactViewRefSchema,
  canonicalJson,
  exactViewRef,
  parseView,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewPolicy,
  type ViewSchemaRef,
} from "@info/view";

export const SQLITE_VEC_PACKAGE_VERSION = "0.1.9";
export const SQLITE_VEC_EXTENSION_VERSION = "v0.1.9";
export const SQLITE_VEC_MINIMUM_SQLITE_VERSION = "3.45.0";
export const SQLITE_VEC_EMBEDDING_SCHEMA_NAME = "metaflow.search.embedding";
export const SQLITE_VEC_EMBEDDING_REPRESENTATION_KIND = "metaflow.search.embedding";

const DIGEST_PATTERN = "^[a-f0-9]{64}$";
const MAX_VECTOR_DIMENSION = 4_096;
const MAX_QUERY_VECTOR_ROWS = 4_096;

export const SqliteVecEmbeddingJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["contract_version", "target", "profile", "vector"],
  properties: {
    contract_version: { const: 1 },
    target: {
      type: "object",
      additionalProperties: false,
      required: ["ref", "location", "source_digest"],
      properties: {
        ref: {
          type: "object",
          additionalProperties: false,
          required: ["view_id", "revision"],
          properties: {
            view_id: { type: "string", minLength: 1, maxLength: 240 },
            revision: { type: "integer", minimum: 1 },
          },
        },
        location: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { enum: ["envelope", "representation"] },
            path: { type: "string", pattern: "^/" },
          },
        },
        source_digest: { type: "string", pattern: DIGEST_PATTERN },
      },
    },
    profile: {
      type: "object",
      additionalProperties: false,
      required: ["id", "revision", "provider", "model", "dimension", "distance_metric"],
      properties: {
        id: { type: "string", minLength: 1, maxLength: 240 },
        revision: { type: "integer", minimum: 1 },
        provider: { type: "string", minLength: 1, maxLength: 240 },
        model: { type: "string", minLength: 1, maxLength: 240 },
        dimension: { type: "integer", minimum: 1, maximum: MAX_VECTOR_DIMENSION },
        distance_metric: { enum: ["cosine", "l2"] },
      },
    },
    vector: {
      type: "array",
      minItems: 1,
      maxItems: MAX_VECTOR_DIMENSION,
      items: { type: "number" },
    },
  },
} as const satisfies JsonValue;

export const SqliteVecEmbeddingViewSchema: ViewSchemaRef = {
  name: SQLITE_VEC_EMBEDDING_SCHEMA_NAME,
  version: 1,
  mode: "strict",
  dialect: "https://json-schema.org/draft/2020-12/schema",
  json_schema: SqliteVecEmbeddingJsonSchema,
};

export const SqliteVecProfileSchema = z.object({
  id: z.string().trim().min(1).max(240),
  revision: z.number().int().positive(),
  provider: z.string().trim().min(1).max(240),
  model: z.string().trim().min(1).max(240),
  dimension: z.number().int().positive().max(MAX_VECTOR_DIMENSION),
  distance_metric: z.enum(["cosine", "l2"]),
}).strict();

export type SqliteVecProfile = z.infer<typeof SqliteVecProfileSchema>;

const EmbeddingValueSchema = z.object({
  contract_version: z.literal(1),
  target: z.object({
    ref: ExactViewRefSchema,
    location: z.object({
      kind: z.enum(["envelope", "representation"]),
      path: z.string().startsWith("/"),
    }).strict(),
    source_digest: z.string().regex(new RegExp(DIGEST_PATTERN, "u")),
  }).strict(),
  profile: SqliteVecProfileSchema,
  vector: z.array(z.number().finite()).min(1).max(MAX_VECTOR_DIMENSION),
}).strict();

type EmbeddingValue = z.infer<typeof EmbeddingValueSchema>;
type ProfileRow = SqliteVecProfile & {
  table_name: string;
  extension_version: string;
};
type MappingRow = {
  vector_rowid: number;
  embedding_view_id: string;
  embedding_revision: number;
  target_view_id: string;
  target_revision: number;
  target_kind: "envelope" | "representation";
  target_path: string;
  profile_id: string;
  profile_revision: number;
  source_digest: string;
};
type SemanticRow = MappingRow & { view_json: string; distance: number };
type IntegrityMappingRow = MappingRow & {
  target_key: string;
  dimension: number;
  distance_metric: "cosine" | "l2";
};
type ExpectedEmbedding = {
  view: View;
  value: EmbeddingValue;
  profile: ProfileRow;
};
type IntegrityInspection = {
  vector_rows: number;
  orphans: number;
  missing: number;
  mismatched: number;
  metadata_mismatched: number;
  payload_mismatched: number;
};

export type SqliteVecCompatibilityEvidence = {
  package_version: typeof SQLITE_VEC_PACKAGE_VERSION;
  extension_version: typeof SQLITE_VEC_EXTENSION_VERSION;
  extension_path: string;
  sqlite_version: string;
  sqlite_source_id: string;
  journal_mode: string;
  profiles: SqliteVecProfile[];
};

export type SqliteVecReindexCounts = {
  scanned: number;
  indexed: number;
  excluded: number;
  removed: number;
  orphans_repaired: number;
  missing_rows_repaired: number;
};

export type SqliteVecMaintenanceState =
  | { status: "ready" }
  | { status: "reindex_required"; orphan_rows: number; missing_rows: number };

export class SqliteVecSemanticSearch implements SemanticRetriever {
  readonly compatibility: SqliteVecCompatibilityEvidence;
  private readonly profiles = new Map<string, ProfileRow>();
  private reindexRequired?: { orphan_rows: number; missing_rows: number };

  private constructor(
    private readonly db: DatabaseSync,
    profiles: ProfileRow[],
    compatibility: SqliteVecCompatibilityEvidence,
  ) {
    for (const profile of profiles) this.profiles.set(profileKey(profile), profile);
    this.compatibility = compatibility;
  }

  static initialize(db: DatabaseSync, profilesValue: SqliteVecProfile[]): SqliteVecSemanticSearch {
    const profiles = parseProfiles(profilesValue);
    verifyPackageVersion();
    const extensionPath = getLoadablePath();
    if (!existsSync(extensionPath)) {
      throw new SqliteVecSemanticSearchError("Pinned sqlite-vec loadable extension is missing", "extension_missing");
    }
    loadSqliteVec(db);
    const compatibility = verifyRuntimeCompatibility(db, extensionPath, profiles);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = readProfileRows(db);
      const configuredKeys = new Set(profiles.map(profileKey));
      const unexpected = existing.find(profile => !configuredKeys.has(profileKey(profile)));
      if (unexpected) {
        throw new SqliteVecSemanticSearchError(
          `Stored semantic profile ${profileKey(unexpected)} is not configured`,
          "profile_mismatch",
        );
      }
      for (const profile of profiles) ensureProfile(db, profile);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "sqlite-vec startup and rollback both failed");
      }
      throw error;
    }
    const stored = readProfileRows(db);
    const semanticSearch = new SqliteVecSemanticSearch(db, stored, compatibility);
    semanticSearch.initializeMaintenanceState();
    return semanticSearch;
  }

  get maintenance(): SqliteVecMaintenanceState {
    return this.reindexRequired
      ? { status: "reindex_required", ...this.reindexRequired }
      : { status: "ready" };
  }

  refreshMaintenanceState(): SqliteVecMaintenanceState {
    if (!this.reindexRequired) this.latchIntegrity(this.inspectIntegrity());
    return this.maintenance;
  }

  static assertUnconfiguredDatabase(db: DatabaseSync): void {
    const row = db.prepare("select profile_id, profile_revision from view_search_vector_profiles_v1 limit 1").get() as {
      profile_id: string;
      profile_revision: number;
    } | undefined;
    if (row) {
      throw new SqliteVecSemanticSearchError(
        `Semantic profile ${row.profile_id}@${row.profile_revision} exists but sqlite-vec is not configured`,
        "configuration_required",
      );
    }
  }

  insert(view: View, plannedViews?: ReadonlyMap<string, View>): "indexed" | "excluded" | "not_embedding" {
    const value = embeddingValue(view);
    if (!value) return "not_embedding";
    this.assertReady("insert");
    return this.insertEmbedding(view, value, plannedViews);
  }

  private insertEmbedding(
    view: View,
    value: EmbeddingValue,
    plannedViews?: ReadonlyMap<string, View>,
  ): "indexed" | "excluded" {
    const profile = this.requireProfile(value.profile);
    const target = plannedViews?.get(refKey(value.target.ref)) ?? this.readTarget(value.target.ref);
    assertEmbeddingEvidence(view, value, target, profile);
    if (view.policy.allow_local_search === false || target.policy.allow_local_search === false) return "excluded";

    const vectorRowid = Number((this.db.prepare(`
      select coalesce(max(vector_rowid), 0) + 1 as vector_rowid
      from view_search_vectors_v1
      where profile_id = ? and profile_revision = ?
    `).get(profile.id, profile.revision) as { vector_rowid: number }).vector_rowid);
    this.db.prepare(`
      insert into view_search_vectors_v1 (
        vector_rowid, embedding_view_id, embedding_revision, target_view_id, target_revision,
        target_kind, target_path, target_key, profile_id, profile_revision,
        dimension, distance_metric, source_digest, indexed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      BigInt(vectorRowid),
      view.id,
      view.revision,
      value.target.ref.view_id,
      value.target.ref.revision,
      value.target.location.kind,
      value.target.location.path,
      refKey(value.target.ref),
      profile.id,
      profile.revision,
      profile.dimension,
      profile.distance_metric,
      value.target.source_digest,
      view.time.created_at,
    );
    this.db.prepare(`
      insert into ${quoteIdentifier(profile.table_name)} (
        rowid, embedding, target_key, target_kind, profile_id, profile_revision
      ) values (?, ?, ?, ?, ?, ?)
    `).run(
      BigInt(vectorRowid),
      canonicalFloat32Bytes(value.vector, profile.distance_metric),
      refKey(value.target.ref),
      value.target.location.kind,
      profile.id,
      BigInt(profile.revision),
    );
    return "indexed";
  }

  delete(ref: ExactViewRef): number {
    this.assertReady("delete");
    const rows = this.db.prepare(`
      select vector_rowid, profile_id, profile_revision, target_key, target_kind
      from view_search_vectors_v1
      where (embedding_view_id = ? and embedding_revision = ?)
         or (target_view_id = ? and target_revision = ?)
      order by vector_rowid
    `).all(ref.view_id, ref.revision, ref.view_id, ref.revision) as Array<{
      vector_rowid: number;
      profile_id: string;
      profile_revision: number;
      target_key: string;
      target_kind: "envelope" | "representation";
    }>;
    for (const row of rows) {
      const profile = this.requireProfile({ id: row.profile_id, revision: Number(row.profile_revision) });
      const physical = this.db.prepare(`
        select profile_id, profile_revision, target_key, target_kind
        from ${quoteIdentifier(profile.table_name)} where rowid = ?
      `).get(BigInt(row.vector_rowid)) as {
        profile_id: string;
        profile_revision: number;
        target_key: string;
        target_kind: string;
      } | undefined;
      if (
        !physical
        || physical.profile_id !== row.profile_id
        || Number(physical.profile_revision) !== Number(row.profile_revision)
        || physical.target_key !== row.target_key
        || physical.target_kind !== row.target_kind
      ) {
        this.latchDetectedIntegrity();
        throw new SqliteVecSemanticSearchError(
          `Vector row ${row.vector_rowid} metadata does not match ${profileKey(profile)}`,
          "vector_mapping_corrupt",
        );
      }
      const deleted = this.db.prepare(`delete from ${quoteIdentifier(profile.table_name)} where rowid = ?`)
        .run(BigInt(row.vector_rowid));
      if (Number(deleted.changes) !== 1) {
        this.latchDetectedIntegrity();
        throw new SqliteVecSemanticSearchError(
          `Vector row ${row.vector_rowid} is missing for ${profileKey(profile)}`,
          "vector_mapping_corrupt",
        );
      }
    }
    if (rows.length > 0) {
      this.db.prepare(`
        delete from view_search_vectors_v1
        where (embedding_view_id = ? and embedding_revision = ?)
           or (target_view_id = ? and target_revision = ?)
      `).run(ref.view_id, ref.revision, ref.view_id, ref.revision);
    }
    return rows.length;
  }

  rebuild(views: View[]): { counts: SqliteVecReindexCounts; mark_committed: () => void } {
    const prior = this.inspectIntegrity();
    for (const profile of this.profiles.values()) {
      this.db.exec(`delete from ${quoteIdentifier(profile.table_name)}`);
    }
    this.db.exec("delete from view_search_vectors_v1");
    let scanned = 0;
    let indexed = 0;
    let excluded = 0;
    for (const view of views) {
      if (!isReservedEmbeddingView(view)) continue;
      scanned += 1;
      const value = embeddingValue(view);
      if (!value) continue;
      const outcome = this.insertEmbedding(view, value);
      if (outcome === "indexed") indexed += 1;
      else excluded += 1;
    }
    const repaired = this.inspectIntegrity();
    if (repaired.orphans !== 0 || repaired.missing !== 0 || repaired.mismatched !== 0) {
      throw new SqliteVecSemanticSearchError("Semantic reindex left inconsistent vector state", "vector_mapping_corrupt");
    }
    return {
      counts: {
        scanned,
        indexed,
        excluded,
        removed: Math.max(0, prior.vector_rows - indexed),
        orphans_repaired: prior.orphans,
        missing_rows_repaired: prior.missing + prior.mismatched,
      },
      mark_committed: () => {
        this.reindexRequired = undefined;
      },
    };
  }

  async retrieve(input: {
    vector: unknown;
    profile: ExactEmbeddingProfileRef;
    refs: ExactViewRef[];
    target: SearchTarget;
    candidate_limit: number;
  }): Promise<RankedSearchCandidate[]> {
    this.assertLiveIntegrityForRetrieve();
    if (input.refs.length === 0) return [];
    const vector = QueryVectorSchema.parse(input.vector);
    const profile = this.requireProfile(input.profile);
    if (vector.dimension !== profile.dimension || vector.distance_metric !== profile.distance_metric) {
      throw new SqliteVecSemanticSearchError(
        `Query vector does not match ${profileKey(profile)} dimension and metric`,
        "query_vector_mismatch",
      );
    }
    const refs = uniqueRefs(input.refs);
    this.assertScopedEvidenceIndexed(refs, profile);
    const targetKinds = [
      ...(input.target.envelope ? ["envelope"] : []),
      ...(input.target.internal ? ["representation"] : []),
    ];
    if (targetKinds.length === 0) return [];
    const eligible = Number((this.db.prepare(`
      select count(*) as count
      from view_search_vectors_v1
      where profile_id = ? and profile_revision = ?
        and target_key in (${placeholders(refs.length)})
        and target_kind in (${placeholders(targetKinds.length)})
    `).get(profile.id, profile.revision, ...refs.map(refKey), ...targetKinds) as { count: number }).count);
    if (eligible === 0) return [];
    if (eligible > MAX_QUERY_VECTOR_ROWS) {
      throw new SqliteVecSemanticSearchError(
        `Authorized semantic scope has ${eligible} vectors; maximum is ${MAX_QUERY_VECTOR_ROWS}`,
        "semantic_scope_too_large",
      );
    }
    const rows = this.db.prepare(`
      with nearest as (
        select rowid, distance, target_key, target_kind, profile_id, profile_revision
        from ${quoteIdentifier(profile.table_name)}
        where embedding match ? and k = ?
          and target_key in (${placeholders(refs.length)})
          and target_kind in (${placeholders(targetKinds.length)})
          and profile_id = ? and profile_revision = ?
      )
      select m.vector_rowid, m.embedding_view_id, m.embedding_revision,
             m.target_view_id, m.target_revision, m.target_kind, m.target_path,
             m.profile_id, m.profile_revision, m.source_digest,
             r.view_json, nearest.distance
      from nearest
      join view_search_vectors_v1 m
        on m.vector_rowid = nearest.rowid
       and m.profile_id = nearest.profile_id
       and m.profile_revision = nearest.profile_revision
       and m.target_key = nearest.target_key
       and m.target_kind = nearest.target_kind
      join view_revisions_v1 r on r.id = m.target_view_id and r.revision = m.target_revision
      order by nearest.distance asc, m.target_view_id asc, m.target_revision desc,
               m.target_kind asc, m.target_path asc, m.embedding_view_id asc, m.embedding_revision desc
    `).all(
      float32Vector(vector.values, profile.distance_metric),
      BigInt(eligible),
      ...refs.map(refKey),
      ...targetKinds,
      profile.id,
      BigInt(profile.revision),
    ) as SemanticRow[];
    if (rows.length !== eligible) {
      this.latchDetectedIntegrity();
      throw new SqliteVecSemanticSearchError(
        `Semantic profile ${profileKey(profile)} has inconsistent mapping and vec0 rows in the authorized scope`,
        "vector_mapping_corrupt",
      );
    }

    const candidates = new Map<string, RankedSearchCandidate>();
    for (const row of rows) {
      const key = `${row.target_view_id}@${row.target_revision}`;
      const targetView = parseView(JSON.parse(row.view_json));
      const match = {
        location: { kind: row.target_kind, path: row.target_path },
        value_digest: row.source_digest,
        modes: ["semantic" as const],
        semantic_evidence_ref: {
          view_id: row.embedding_view_id,
          revision: Number(row.embedding_revision),
        },
      };
      const existing = candidates.get(key);
      if (existing) {
        if (existing.matches.length >= 128) {
          throw new SqliteVecSemanticSearchError("One target exceeds 128 semantic match locations", "semantic_scope_too_large");
        }
        existing.matches.push(match);
        continue;
      }
      if (candidates.size >= boundedCandidateLimit(input.candidate_limit)) continue;
      candidates.set(key, {
        ref: exactViewRef(targetView),
        owner_ref: exactViewRef(targetView),
        matched_schema: { name: targetView.schema.name, version: targetView.schema.version },
        representation_kind: targetView.representation.kind,
        matches: [match],
      });
    }
    return [...candidates.values()];
  }

  private requireProfile(ref: Pick<SqliteVecProfile, "id" | "revision">): ProfileRow {
    const profile = this.profiles.get(profileKey(ref));
    if (!profile) {
      throw new SqliteVecSemanticSearchError(`Semantic profile ${profileKey(ref)} is not configured`, "profile_not_configured");
    }
    return profile;
  }

  private readTarget(ref: ExactViewRef): View {
    const row = this.db.prepare("select view_json from view_revisions_v1 where id = ? and revision = ?")
      .get(ref.view_id, ref.revision) as { view_json: string } | undefined;
    if (!row) throw new SqliteVecSemanticSearchError(`Embedding target ${refKey(ref)} does not exist`, "target_missing");
    return parseView(JSON.parse(row.view_json));
  }

  private assertScopedEvidenceIndexed(refs: ExactViewRef[], profile: ProfileRow): void {
    const rows = this.db.prepare(`
      with scoped(view_id, revision) as (values ${refs.map(() => "(?, ?)").join(", ")})
      select r.view_json
      from scoped s
      join view_revisions_v1 r on r.id = s.view_id and r.revision = s.revision
      where r.schema_name = ?
    `).all(...refs.flatMap(ref => [ref.view_id, ref.revision]), SQLITE_VEC_EMBEDDING_SCHEMA_NAME) as Array<{ view_json: string }>;
    for (const row of rows) {
      const view = parseView(JSON.parse(row.view_json));
      const value = embeddingValue(view);
      if (!value || profileKey(value.profile) !== profileKey(profile)) continue;
      const mapping = this.db.prepare(`
        select vector_rowid from view_search_vectors_v1
        where embedding_view_id = ? and embedding_revision = ?
          and profile_id = ? and profile_revision = ?
      `).get(view.id, view.revision, profile.id, profile.revision);
      if (!mapping) {
        this.latchDetectedIntegrity();
        throw new SqliteVecSemanticSearchError(
          `Committed embedding ${view.id}@${view.revision} requires explicit semantic reindex`,
          "vector_mapping_corrupt",
        );
      }
    }
  }

  private inspectIntegrity(): IntegrityInspection {
    const expected = this.expectedEligibleEmbeddings();
    const mappings = this.db.prepare(`
      select vector_rowid, embedding_view_id, embedding_revision,
             target_view_id, target_revision, target_kind, target_path, target_key,
             profile_id, profile_revision, dimension, distance_metric, source_digest
      from view_search_vectors_v1
      order by embedding_view_id, embedding_revision
    `).all() as IntegrityMappingRow[];
    const mappingsByEmbedding = new Map(
      mappings.map(mapping => [refKey({
        view_id: mapping.embedding_view_id,
        revision: Number(mapping.embedding_revision),
      }), mapping]),
    );
    let vectorRows = 0;
    let orphans = 0;
    const missingKeys = new Set<string>();
    const metadataMismatchKeys = new Set<string>();
    const payloadMismatchKeys = new Set<string>();
    for (const profile of this.profiles.values()) {
      vectorRows += Number((this.db.prepare(`select count(*) as count from ${quoteIdentifier(profile.table_name)}`).get() as { count: number }).count);
      orphans += Number((this.db.prepare(`
        select count(*) as count from ${quoteIdentifier(profile.table_name)} v
        left join view_search_vectors_v1 m
          on m.vector_rowid = v.rowid
         and m.profile_id = ? and m.profile_revision = ?
        where m.vector_rowid is null
      `).get(profile.id, profile.revision) as { count: number }).count);
    }

    for (const mapping of mappings) {
      const key = refKey({
        view_id: mapping.embedding_view_id,
        revision: Number(mapping.embedding_revision),
      });
      if (!expected.has(key)) metadataMismatchKeys.add(key);
    }
    for (const [key, embedding] of expected) {
      const mapping = mappingsByEmbedding.get(key);
      if (!mapping) {
        missingKeys.add(key);
        continue;
      }
      if (!mappingMatchesExpected(mapping, embedding)) {
        metadataMismatchKeys.add(key);
      }
      const physical = this.db.prepare(`
        select embedding, target_key, target_kind, profile_id, profile_revision
        from ${quoteIdentifier(embedding.profile.table_name)} where rowid = ?
      `).get(BigInt(mapping.vector_rowid)) as {
        embedding: Uint8Array;
        target_key: string;
        target_kind: string;
        profile_id: string;
        profile_revision: number;
      } | undefined;
      if (!physical) {
        missingKeys.add(key);
        continue;
      }
      if (
        physical.target_key !== refKey(embedding.value.target.ref)
        || physical.target_kind !== embedding.value.target.location.kind
        || physical.profile_id !== embedding.profile.id
        || Number(physical.profile_revision) !== embedding.profile.revision
      ) {
        metadataMismatchKeys.add(key);
      }
      if (!bytesEqual(
        physical.embedding,
        canonicalFloat32Bytes(embedding.value.vector, embedding.profile.distance_metric),
      )) {
        payloadMismatchKeys.add(key);
      }
    }
    const mismatchKeys = new Set([...metadataMismatchKeys, ...payloadMismatchKeys]);
    for (const key of missingKeys) mismatchKeys.delete(key);
    return {
      vector_rows: vectorRows,
      orphans,
      missing: missingKeys.size,
      mismatched: mismatchKeys.size,
      metadata_mismatched: metadataMismatchKeys.size,
      payload_mismatched: payloadMismatchKeys.size,
    };
  }

  private expectedEligibleEmbeddings(): Map<string, ExpectedEmbedding> {
    const rows = this.db.prepare("select view_json from view_revisions_v1 order by id, revision").all() as Array<{
      view_json: string;
    }>;
    const expected = new Map<string, ExpectedEmbedding>();
    for (const row of rows) {
      const view = parseView(JSON.parse(row.view_json));
      if (!isReservedEmbeddingView(view)) continue;
      const value = embeddingValue(view);
      if (!value) continue;
      const profile = this.requireProfile(value.profile);
      const target = this.readTarget(value.target.ref);
      assertEmbeddingEvidence(view, value, target, profile);
      if (view.policy.allow_local_search === false || target.policy.allow_local_search === false) continue;
      expected.set(refKey(exactViewRef(view)), { view, value, profile });
    }
    return expected;
  }

  private initializeMaintenanceState(): void {
    const integrity = this.inspectIntegrity();
    if (integrity.metadata_mismatched !== 0) {
      throw new SqliteVecSemanticSearchError(
        `Semantic vector startup integrity failed: ${integrity.metadata_mismatched} profile or target metadata mismatches`,
        "vector_mapping_corrupt",
      );
    }
    if (integrity.orphans !== 0 || integrity.missing !== 0 || integrity.mismatched !== 0) {
      this.latchIntegrity(integrity);
    }
  }

  private assertLiveIntegrityForRetrieve(): void {
    this.assertReady("retrieve");
    const integrity = this.inspectIntegrity();
    this.latchIntegrity(integrity);
    if (integrity.metadata_mismatched !== 0) {
      throw new SqliteVecSemanticSearchError(
        `Semantic vector live integrity failed: ${integrity.metadata_mismatched} metadata and ${integrity.payload_mismatched} payload mismatches`,
        "vector_mapping_corrupt",
      );
    }
    this.assertReady("retrieve");
  }

  private latchDetectedIntegrity(): void {
    this.latchIntegrity(this.inspectIntegrity());
    this.reindexRequired ??= { orphan_rows: 0, missing_rows: 1 };
  }

  private latchIntegrity(integrity: IntegrityInspection): void {
    if (this.reindexRequired) return;
    if (integrity.orphans === 0 && integrity.missing === 0 && integrity.mismatched === 0) return;
    this.reindexRequired = {
      orphan_rows: integrity.orphans,
      missing_rows: integrity.missing + integrity.mismatched,
    };
  }

  private assertReady(operation: "retrieve" | "insert" | "delete"): void {
    if (!this.reindexRequired) return;
    throw new SqliteVecSemanticSearchError(
      `Semantic ${operation} requires explicit durable reindex: ${this.reindexRequired.orphan_rows} orphan, ${this.reindexRequired.missing_rows} missing rows`,
      "reindex_required",
    );
  }
}

export class SqliteVecSemanticSearchError extends Error {
  constructor(
    message: string,
    readonly code:
      | "configuration_required"
      | "extension_missing"
      | "package_version_mismatch"
      | "extension_version_mismatch"
      | "sqlite_abi_mismatch"
      | "profile_mismatch"
      | "profile_not_configured"
      | "embedding_invalid"
      | "target_missing"
      | "query_vector_mismatch"
      | "semantic_scope_too_large"
      | "reindex_required"
      | "vector_mapping_corrupt",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SqliteVecSemanticSearchError";
  }
}

export function sqliteVecSourceDigest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function verifyPackageVersion(): void {
  const entrypoint = fileURLToPath(import.meta.resolve("sqlite-vec"));
  const manifestPath = join(dirname(entrypoint), "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== "sqlite-vec" || manifest.version !== SQLITE_VEC_PACKAGE_VERSION) {
    throw new SqliteVecSemanticSearchError(
      `sqlite-vec package ${String(manifest.version)} does not match pinned ${SQLITE_VEC_PACKAGE_VERSION}`,
      "package_version_mismatch",
    );
  }
}

function verifyRuntimeCompatibility(
  db: DatabaseSync,
  extensionPath: string,
  profiles: SqliteVecProfile[],
): SqliteVecCompatibilityEvidence {
  const row = db.prepare(`
    select vec_version() as extension_version,
           sqlite_version() as sqlite_version,
           sqlite_source_id() as sqlite_source_id,
           lower((select journal_mode from pragma_journal_mode)) as journal_mode,
           sqlite_compileoption_used('ENABLE_FTS5') as has_fts5
  `).get() as {
    extension_version: string;
    sqlite_version: string;
    sqlite_source_id: string;
    journal_mode: string;
    has_fts5: number;
  };
  if (row.extension_version !== SQLITE_VEC_EXTENSION_VERSION) {
    throw new SqliteVecSemanticSearchError(
      `sqlite-vec ${row.extension_version} does not match pinned ${SQLITE_VEC_EXTENSION_VERSION}`,
      "extension_version_mismatch",
    );
  }
  if (compareVersions(row.sqlite_version, SQLITE_VEC_MINIMUM_SQLITE_VERSION) < 0 || Number(row.has_fts5) !== 1) {
    throw new SqliteVecSemanticSearchError(
      `SQLite ${row.sqlite_version} does not satisfy sqlite-vec/FTS ABI requirements`,
      "sqlite_abi_mismatch",
    );
  }
  const database = db.prepare("select file from pragma_database_list where name = 'main'").get() as { file: string };
  if (database.file && row.journal_mode !== "wal") {
    throw new SqliteVecSemanticSearchError(
      `File-backed semantic Search requires WAL, received ${row.journal_mode}`,
      "sqlite_abi_mismatch",
    );
  }
  const functions = db.prepare(`
    select name from pragma_function_list
    where name in ('vec_version', 'vec_distance_cosine', 'vec_distance_l2', 'vec_length')
  `).all() as Array<{ name: string }>;
  if (new Set(functions.map(item => item.name)).size !== 4) {
    throw new SqliteVecSemanticSearchError("sqlite-vec required ABI functions are unavailable", "sqlite_abi_mismatch");
  }
  return {
    package_version: SQLITE_VEC_PACKAGE_VERSION,
    extension_version: SQLITE_VEC_EXTENSION_VERSION,
    extension_path: extensionPath,
    sqlite_version: row.sqlite_version,
    sqlite_source_id: row.sqlite_source_id,
    journal_mode: row.journal_mode,
    profiles,
  };
}

function ensureProfile(db: DatabaseSync, profile: SqliteVecProfile): void {
  const tableName = vectorTableName(profile);
  const existing = db.prepare(`
    select profile_id as id, profile_revision as revision, provider, model,
           dimension, distance_metric, table_name, extension_version
    from view_search_vector_profiles_v1 where profile_id = ? and profile_revision = ?
  `).get(profile.id, profile.revision) as ProfileRow | undefined;
  if (existing) {
    const expected = { ...profile, table_name: tableName, extension_version: SQLITE_VEC_EXTENSION_VERSION };
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new SqliteVecSemanticSearchError(`Stored semantic profile ${profileKey(profile)} is incompatible`, "profile_mismatch");
    }
    const schema = db.prepare("select sql from sqlite_master where type = 'table' and name = ?")
      .get(tableName) as { sql: string } | undefined;
    if (!schema || !normalizedSql(schema.sql).includes(normalizedSql(vectorTableSql(tableName, profile)))) {
      throw new SqliteVecSemanticSearchError(`Vector table for ${profileKey(profile)} has incompatible dimension or metric`, "profile_mismatch");
    }
    return;
  }
  db.exec(vectorTableSql(tableName, profile));
  db.prepare(`
    insert into view_search_vector_profiles_v1 (
      profile_id, profile_revision, provider, model, dimension, distance_metric,
      table_name, extension_version, created_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    profile.id,
    profile.revision,
    profile.provider,
    profile.model,
    profile.dimension,
    profile.distance_metric,
    tableName,
    SQLITE_VEC_EXTENSION_VERSION,
    new Date().toISOString(),
  );
}

function readProfileRows(db: DatabaseSync): ProfileRow[] {
  const rows = db.prepare(`
    select profile_id as id, profile_revision as revision, provider, model,
           dimension, distance_metric, table_name, extension_version
    from view_search_vector_profiles_v1 order by profile_id, profile_revision
  `).all() as ProfileRow[];
  return rows.map(row => ({
    ...row,
    revision: Number(row.revision),
    dimension: Number(row.dimension),
  }));
}

function vectorTableSql(tableName: string, profile: SqliteVecProfile): string {
  return `create virtual table ${quoteIdentifier(tableName)} using vec0(
    embedding float[${profile.dimension}] distance_metric=${profile.distance_metric},
    target_key text,
    target_kind text,
    profile_id text,
    profile_revision integer
  )`;
}

function parseProfiles(values: SqliteVecProfile[]): SqliteVecProfile[] {
  const profiles = z.array(SqliteVecProfileSchema).min(1).max(32).parse(values);
  const keys = profiles.map(profileKey);
  if (new Set(keys).size !== keys.length) {
    throw new SqliteVecSemanticSearchError("Semantic profiles must be unique by id and revision", "profile_mismatch");
  }
  return [...profiles].sort((left, right) => profileKey(left).localeCompare(profileKey(right)));
}

function embeddingValue(view: View): EmbeddingValue | undefined {
  if (!isReservedEmbeddingView(view)) return undefined;
  if (
    view.role !== "derived"
    || view.representation.form !== "inline"
    || view.representation.kind !== SQLITE_VEC_EMBEDDING_REPRESENTATION_KIND
    || view.schema.mode !== "strict"
    || view.schema.version !== 1
    || canonicalJson(view.schema.json_schema) !== canonicalJson(SqliteVecEmbeddingJsonSchema)
  ) {
    throw new SqliteVecSemanticSearchError("Reserved embedding View does not use the exact strict v1 contract", "embedding_invalid");
  }
  const parsed = EmbeddingValueSchema.safeParse(view.representation.value);
  if (!parsed.success) {
    throw new SqliteVecSemanticSearchError("Embedding View value is invalid", "embedding_invalid", { cause: parsed.error });
  }
  return parsed.data;
}

function isReservedEmbeddingView(view: View): boolean {
  return view.schema.name === SQLITE_VEC_EMBEDDING_SCHEMA_NAME
    || view.representation.kind === SQLITE_VEC_EMBEDDING_REPRESENTATION_KIND;
}

function assertEmbeddingEvidence(view: View, value: EmbeddingValue, target: View, profile: ProfileRow): void {
  if (!view.provenance.operator_run_id || !view.provenance.inputs.some(ref => refKey(ref) === refKey(value.target.ref))) {
    throw new SqliteVecSemanticSearchError("Embedding View must freeze its target input and Transformation Run", "embedding_invalid");
  }
  if (!target.policy.allow_embedding) {
    throw new SqliteVecSemanticSearchError(`Embedding target ${refKey(value.target.ref)} forbids embedding`, "embedding_invalid");
  }
  if (!policyIsAtLeastAsStrict(view.policy, target.policy)) {
    throw new SqliteVecSemanticSearchError(
      `Embedding View policy weakens or changes owner of target ${refKey(value.target.ref)}`,
      "embedding_invalid",
    );
  }
  if (
    value.profile.id !== profile.id
    || value.profile.revision !== profile.revision
    || value.profile.provider !== profile.provider
    || value.profile.model !== profile.model
    || value.profile.dimension !== profile.dimension
    || value.profile.distance_metric !== profile.distance_metric
    || value.vector.length !== profile.dimension
  ) {
    throw new SqliteVecSemanticSearchError(`Embedding View does not match ${profileKey(profile)}`, "embedding_invalid");
  }
  if (value.target.location.kind === "representation" && !value.target.location.path.startsWith("/representation/")) {
    throw new SqliteVecSemanticSearchError("Representation embedding location must be inside /representation", "embedding_invalid");
  }
  if (value.target.location.kind === "envelope" && value.target.location.path.startsWith("/representation/")) {
    throw new SqliteVecSemanticSearchError("Envelope embedding location cannot point inside /representation", "embedding_invalid");
  }
  const source = valueAtPointer(target as unknown as JsonValue, value.target.location.path);
  if (source === undefined || sqliteVecSourceDigest(source) !== value.target.source_digest) {
    throw new SqliteVecSemanticSearchError("Embedding source digest does not match the exact target location", "embedding_invalid");
  }
}

function mappingMatchesExpected(mapping: IntegrityMappingRow, expected: ExpectedEmbedding): boolean {
  const { view, value, profile } = expected;
  return mapping.embedding_view_id === view.id
    && Number(mapping.embedding_revision) === view.revision
    && mapping.target_view_id === value.target.ref.view_id
    && Number(mapping.target_revision) === value.target.ref.revision
    && mapping.target_kind === value.target.location.kind
    && mapping.target_path === value.target.location.path
    && mapping.target_key === refKey(value.target.ref)
    && mapping.profile_id === profile.id
    && Number(mapping.profile_revision) === profile.revision
    && Number(mapping.dimension) === profile.dimension
    && mapping.distance_metric === profile.distance_metric
    && mapping.source_digest === value.target.source_digest;
}

function policyIsAtLeastAsStrict(candidate: ViewPolicy, inherited: ViewPolicy): boolean {
  const visibility = { public: 0, shared: 1, private: 2 } as const;
  const privacy = { public: 0, private: 1, sensitive: 2 } as const;
  const retention = { archive: 0, normal: 1, session: 2, do_not_store: 3 } as const;
  return candidate.owner === inherited.owner
    && visibility[candidate.visibility] >= visibility[inherited.visibility]
    && privacy[candidate.privacy] >= privacy[inherited.privacy]
    && retention[candidate.retention] >= retention[inherited.retention]
    && (!candidate.allow_external_model || inherited.allow_external_model)
    && (!candidate.allow_embedding || inherited.allow_embedding)
    && (candidate.allow_local_search === false || inherited.allow_local_search !== false)
    && inherited.labels.every(label => candidate.labels.includes(label));
}

function valueAtPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: JsonValue = root;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) return undefined;
      const value = current[Number(token)];
      if (value === undefined) return undefined;
      current = value;
      continue;
    }
    if (current === null || typeof current !== "object") return undefined;
    const value = current[token];
    if (value === undefined) return undefined;
    current = value;
  }
  return current;
}

function vectorTableName(profile: SqliteVecProfile): string {
  const digest = createHash("sha256").update(canonicalJson(profile)).digest("hex").slice(0, 20);
  return `view_search_vec0_${digest}`;
}

function profileKey(profile: Pick<SqliteVecProfile, "id" | "revision">): string {
  return `${profile.id}@${profile.revision}`;
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  const unique = new Map<string, ExactViewRef>();
  for (const ref of refs) unique.set(refKey(ref), ExactViewRefSchema.parse(ref));
  return [...unique.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/u.test(value)) throw new TypeError(`Unsafe SQLite identifier ${value}`);
  return `"${value}"`;
}

function placeholders(count: number): string {
  if (!Number.isInteger(count) || count < 1) throw new TypeError("placeholder count must be positive");
  return Array.from({ length: count }, () => "?").join(", ");
}

function boundedCandidateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 1_000) {
    throw new SqliteVecSemanticSearchError("candidate_limit must be between 1 and 1000", "semantic_scope_too_large");
  }
  return value;
}

function float32Vector(values: number[], metric: "cosine" | "l2"): Float32Array {
  const vector = new Float32Array(values);
  if ([...vector].some(value => !Number.isFinite(value))) {
    throw new SqliteVecSemanticSearchError("Vector values must remain finite as float32", "embedding_invalid");
  }
  if (metric === "cosine" && ![...vector].some(value => value !== 0)) {
    throw new SqliteVecSemanticSearchError("Cosine vectors must have non-zero magnitude", "embedding_invalid");
  }
  return vector;
}

function canonicalFloat32Bytes(values: number[], metric: "cosine" | "l2"): Uint8Array {
  const vector = float32Vector(values.map(value => Object.is(value, -0) ? 0 : value), metric);
  const bytes = new Uint8Array(vector.length * Float32Array.BYTES_PER_ELEMENT);
  const data = new DataView(bytes.buffer);
  for (let index = 0; index < vector.length; index += 1) {
    data.setFloat32(index * Float32Array.BYTES_PER_ELEMENT, vector[index]!, true);
  }
  return bytes;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split(".").map(part => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function normalizedSql(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/gu, "").replace(/^createvirtualtable/gu, "createvirtualtable");
}
