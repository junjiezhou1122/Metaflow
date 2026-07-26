import type { DatabaseSync } from "node:sqlite";
import {
  compileViewSearchMatchExpression,
  exactViewRef,
  parseView,
  type ExactViewRef,
  type View,
} from "@info/view";
import {
  type KeywordRetriever,
  type RankedSearchCandidate,
  type SearchMatchV1,
  type SearchPathStep,
  type SearchScopeSource,
  type SearchTarget,
  type SearchViewDescriptorReader,
} from "@info/search";

type ViewJsonRow = { view_json: string };
type RankedViewRow = { view_json: string; search_score: number };
type UnitEvidenceRow = {
  view_id: string;
  revision: number;
  expanded_path: string;
  value_digest: string;
  snippet: string;
};
type RelationRow = {
  id: string;
  type: string;
  source_view_id: string;
  source_revision: number;
  target_view_id: string;
  target_revision: number;
};

export class SqliteViewSearchAdapter implements SearchScopeSource, SearchViewDescriptorReader, KeywordRetriever {
  constructor(private readonly db: DatabaseSync) {}

  async listLatestExactRefs(input: {
    after_view_id?: string;
    limit: number;
  }): Promise<{ refs: ExactViewRef[]; next_after_view_id?: string }> {
    const limit = boundedInteger(input.limit, 1, 1_000, "limit");
    if (input.after_view_id !== undefined && !input.after_view_id.trim()) {
      throw new SqliteSearchError("after_view_id must be a non-empty string", "invalid_request");
    }
    const rows = this.db.prepare(`
      select id as view_id, revision
      from view_heads_v1
      where (? is null or id > ?)
      order by id asc, revision desc
      limit ?
    `).all(input.after_view_id ?? null, input.after_view_id ?? null, limit + 1) as Array<{ view_id: string; revision: number }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(row => ({ view_id: row.view_id, revision: Number(row.revision) }));
    return {
      refs: page,
      ...(hasMore ? { next_after_view_id: page.at(-1)!.view_id } : {}),
    };
  }

  async readRelations(input: {
    frontier: ExactViewRef[];
    direction: "incoming" | "outgoing" | "both";
    relation_types: string[];
  }): Promise<SearchPathStep[]> {
    if (input.frontier.length === 0) return [];
    const frontier = uniqueRefs(input.frontier);
    const relationTypes = uniqueStrings(input.relation_types, "relation_types");
    const frontierCte = valuesCte(frontier.length);
    const match = input.direction === "outgoing"
      ? "r.source_view_id = f.view_id and r.source_revision = f.revision"
      : input.direction === "incoming"
        ? "r.target_view_id = f.view_id and r.target_revision = f.revision"
        : "((r.source_view_id = f.view_id and r.source_revision = f.revision) or (r.target_view_id = f.view_id and r.target_revision = f.revision))";
    const rows = this.db.prepare(`
      with frontier(view_id, revision) as (${frontierCte})
      select distinct r.id, r.type, r.source_view_id, r.source_revision, r.target_view_id, r.target_revision
      from frontier f
      join view_relations_v1 r on ${match}
      where r.type in (${placeholders(relationTypes.length)})
      order by r.id asc, r.type asc, r.source_view_id asc, r.source_revision desc, r.target_view_id asc, r.target_revision desc
    `).all(...flattenRefs(frontier), ...relationTypes) as RelationRow[];
    return rows.map(row => ({
      relation_id: row.id,
      type: row.type,
      from: { view_id: row.source_view_id, revision: Number(row.source_revision) },
      to: { view_id: row.target_view_id, revision: Number(row.target_revision) },
    }));
  }

  async describe(refsValue: ExactViewRef[]): Promise<Array<{
    ref: ExactViewRef;
    schema: { name: string; version: number };
    representation_kind: string;
  }>> {
    if (refsValue.length === 0) return [];
    const refs = uniqueRefs(refsValue);
    const rows = this.db.prepare(`
      with authorized(view_id, revision) as (${valuesCte(refs.length)})
      select r.view_json
      from authorized a
      join view_revisions_v1 r on r.id = a.view_id and r.revision = a.revision
      order by r.id asc, r.revision desc
    `).all(...flattenRefs(refs)) as ViewJsonRow[];
    return rows.map(row => descriptor(parseStoredView(row.view_json)));
  }

  async retrieve(input: {
    text: string;
    refs: ExactViewRef[];
    target: SearchTarget;
    candidate_limit: number;
  }): Promise<RankedSearchCandidate[]> {
    if (input.refs.length === 0) return [];
    const refs = uniqueRefs(input.refs);
    const candidateLimit = boundedInteger(input.candidate_limit, 1, 1_000, "candidate_limit");
    const expression = compileSearchExpression(input.text);
    const candidates = input.target.envelope && input.target.internal
      ? this.aggregateCandidates(refs, expression, candidateLimit)
      : this.targetedCandidates(refs, input.text, input.target, candidateLimit);
    if (candidates.length === 0) return [];
    const candidateViews = candidates.map(row => parseStoredView(row.view_json));
    const evidence = this.unitEvidence(candidateViews.map(exactViewRef), expression.replaceAll(" AND ", " OR "), input.target);
    const evidenceByRef = new Map<string, SearchMatchV1[]>();
    for (const row of evidence) {
      const key = `${row.view_id}@${row.revision}`;
      const location = row.expanded_path === "/representation" || row.expanded_path.startsWith("/representation/")
        ? { kind: "representation" as const, path: row.expanded_path }
        : { kind: "envelope" as const, path: row.expanded_path };
      const matches = evidenceByRef.get(key) ?? [];
      matches.push({
        location,
        snippet: truncateUtf8(row.snippet, 320),
        value_digest: row.value_digest,
        modes: ["keyword"],
      });
      evidenceByRef.set(key, matches);
    }
    return candidateViews.flatMap(view => {
      const matches = evidenceByRef.get(`${view.id}@${view.revision}`);
      return matches && matches.length > 0 ? [{
        ref: exactViewRef(view),
        owner_ref: exactViewRef(view),
        matched_schema: { name: view.schema.name, version: view.schema.version },
        representation_kind: view.representation.kind,
        matches: matches.sort((left, right) => locationKey(left).localeCompare(locationKey(right)) || left.value_digest.localeCompare(right.value_digest)),
      }] : [];
    });
  }

  private aggregateCandidates(refs: ExactViewRef[], expression: string, limit: number): RankedViewRow[] {
    return this.db.prepare(`
      with authorized(view_id, revision) as (${valuesCte(refs.length)})
      select r.view_json,
             bm25(view_search_fts_v1, 12.0, 6.0, 4.0, 3.0, 2.0, 1.0) as search_score
      from authorized a
      join view_search_projection_v1 p on p.view_id = a.view_id and p.revision = a.revision
      join view_search_fts_v1 on view_search_fts_v1.rowid = p.search_rowid
      join view_revisions_v1 r on r.id = a.view_id and r.revision = a.revision
      where view_search_fts_v1 match ?
      order by search_score asc, r.id asc, r.revision desc
      limit ?
    `).all(...flattenRefs(refs), expression, limit) as RankedViewRow[];
  }

  private targetedCandidates(refs: ExactViewRef[], text: string, target: SearchTarget, limit: number): RankedViewRow[] {
    const tokens = searchTokens(text);
    const scores = new Map<string, { view_json: string; score: number; matched: number }>();
    const pathClause = target.internal
      ? "(u.expanded_path = '/representation' or u.expanded_path like '/representation/%')"
      : "not (u.expanded_path = '/representation' or u.expanded_path like '/representation/%')";
    for (const token of tokens) {
      const rows = this.db.prepare(`
        with authorized(view_id, revision) as (${valuesCte(refs.length)})
        select r.view_json, r.id, r.revision,
               min(bm25(view_search_unit_fts_v2, 12.0, 6.0, 4.0, 3.0, 2.0, 1.0)) as search_score
        from authorized a
        join view_search_units_v2 u on u.view_id = a.view_id and u.revision = a.revision
        join view_search_unit_fts_v2 on view_search_unit_fts_v2.rowid = u.search_unit_id
        join view_revisions_v1 r on r.id = a.view_id and r.revision = a.revision
        where view_search_unit_fts_v2 match ? and ${pathClause}
        group by r.id, r.revision, r.view_json
        order by search_score asc, r.id asc, r.revision desc
      `).all(...flattenRefs(refs), quoteFtsToken(token)) as Array<RankedViewRow & { id: string; revision: number }>;
      for (const row of rows) {
        const view = parseStoredView(row.view_json);
        const key = `${view.id}@${view.revision}`;
        const current = scores.get(key) ?? { view_json: row.view_json, score: 0, matched: 0 };
        current.score += Number(row.search_score);
        current.matched += 1;
        scores.set(key, current);
      }
    }
    return [...scores.values()]
      .filter(item => item.matched === tokens.length)
      .sort((left, right) => left.score - right.score || compareViewJsonIdentity(left.view_json, right.view_json))
      .slice(0, limit)
      .map(item => ({ view_json: item.view_json, search_score: item.score }));
  }

  private unitEvidence(refs: ExactViewRef[], expression: string, target: SearchTarget): UnitEvidenceRow[] {
    const targetClauses: string[] = [];
    if (target.envelope) targetClauses.push("not (u.expanded_path = '/representation' or u.expanded_path like '/representation/%')");
    if (target.internal) targetClauses.push("(u.expanded_path = '/representation' or u.expanded_path like '/representation/%')");
    if (targetClauses.length === 0) return [];
    const statement = this.db.prepare(`
      select u.view_id, u.revision, u.expanded_path, u.value_digest,
             snippet(view_search_unit_fts_v2, -1, '', '', ' ... ', 24) as snippet
      from view_search_units_v2 u
      join view_search_unit_fts_v2 on view_search_unit_fts_v2.rowid = u.search_unit_id
      where u.view_id = ? and u.revision = ?
        and view_search_unit_fts_v2 match ?
        and (${targetClauses.join(" or ")})
      order by u.ordinal asc, u.expanded_path asc, u.value_digest asc
      limit 128
    `);
    return refs.flatMap(ref => statement.all(ref.view_id, ref.revision, expression) as UnitEvidenceRow[]);
  }
}

function locationKey(match: SearchMatchV1): string {
  return match.location.kind === "related_view"
    ? `related:${match.location.ref.view_id}@${match.location.ref.revision}`
    : `${match.location.kind}:${match.location.path}`;
}

export class SqliteSearchError extends Error {
  constructor(message: string, readonly code: "invalid_request", options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteSearchError";
  }
}

function descriptor(view: View) {
  return {
    ref: exactViewRef(view),
    schema: { name: view.schema.name, version: view.schema.version },
    representation_kind: view.representation.kind,
  };
}

function parseStoredView(value: string): View {
  return parseView(JSON.parse(value));
}

function compileSearchExpression(text: string): string {
  try {
    return compileViewSearchMatchExpression(text);
  } catch (cause) {
    throw new SqliteSearchError("Search text does not contain searchable tokens", "invalid_request", { cause });
  }
}

function searchTokens(text: string): string[] {
  const expression = compileSearchExpression(text);
  return expression.split(" AND ").map(token => token.slice(1, -1).replaceAll('""', '"'));
}

function quoteFtsToken(token: string): string {
  return `"${token.replaceAll('"', '""')}"`;
}

function valuesCte(count: number): string {
  return `values ${Array.from({ length: count }, () => "(?, ?)").join(", ")}`;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function flattenRefs(refs: ExactViewRef[]): Array<string | number> {
  return refs.flatMap(ref => [ref.view_id, ref.revision]);
}

function uniqueRefs(refs: ExactViewRef[]): ExactViewRef[] {
  const keys = refs.map(ref => `${ref.view_id}@${ref.revision}`);
  if (new Set(keys).size !== keys.length) throw new SqliteSearchError("Exact View refs must be unique", "invalid_request");
  return refs;
}

function uniqueStrings(values: string[], label: string): string[] {
  if (values.length === 0 || values.some(value => !value.trim()) || new Set(values).size !== values.length) {
    throw new SqliteSearchError(`${label} must be non-empty and unique`, "invalid_request");
  }
  return values;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new SqliteSearchError(`${label} must be an integer from ${minimum} through ${maximum}`, "invalid_request");
  }
  return value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}...`;
}

function compareViewJsonIdentity(leftJson: string, rightJson: string): number {
  const left = parseStoredView(leftJson);
  const right = parseStoredView(rightJson);
  return left.id.localeCompare(right.id) || right.revision - left.revision;
}
