import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  TimestampSchema,
  canonicalJson,
  type ExactViewRef,
  type JsonValue,
  type View,
  type ViewSearchProjectionField,
} from "@info/view";

export type SqliteSearchUnit = {
  ordinal: number;
  category: ViewSearchProjectionField["category"];
  expanded_path: string;
  normalized_value: string;
  value_digest: string;
};

const MAX_SEARCH_UNITS_PER_VIEW = 4_096;

type UnitRow = {
  search_unit_id: number;
  ordinal: number;
  category: ViewSearchProjectionField["category"];
  expanded_path: string;
  value_digest: string;
  title: string;
  text: string;
  identifiers: string;
  urls: string;
  timestamps: string;
  provenance: string;
};

export function projectSqliteSearchUnits(view: View): SqliteSearchUnit[] {
  const declaration = view.schema.search_projection;
  if (!declaration || view.policy.allow_local_search === false) return [];
  const units: SqliteSearchUnit[] = [];
  for (const [ordinal, field] of declaration.fields.entries()) {
    for (const resolved of resolveExpandedPath(view as unknown as JsonValue, field.path)) {
      const normalized = normalizeSearchUnitValue(field, resolved.value, view);
      if (normalized === undefined) continue;
      units.push({
        ordinal,
        category: field.category,
        expanded_path: resolved.path,
        normalized_value: normalized,
        value_digest: createHash("sha256").update(normalized).digest("hex"),
      });
      if (units.length > MAX_SEARCH_UNITS_PER_VIEW) {
        throw new TypeError(`Search projection for ${view.id}@${view.revision} exceeds ${MAX_SEARCH_UNITS_PER_VIEW} scalar units`);
      }
    }
  }
  return units;
}

export function insertSqliteSearchUnits(db: DatabaseSync, view: View, indexedAt: string): number {
  const units = projectSqliteSearchUnits(view);
  const insertUnit = db.prepare(`
    insert into view_search_units_v2 (
      view_id, revision, ordinal, category, expanded_path, value_digest, indexed_at
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFts = db.prepare(`
    insert into view_search_unit_fts_v2 (
      rowid, title, text, identifiers, urls, timestamps, provenance
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const unit of units) {
    const inserted = insertUnit.run(
      view.id,
      view.revision,
      unit.ordinal,
      unit.category,
      unit.expanded_path,
      unit.value_digest,
      indexedAt,
    );
    const columns = unitColumns(unit);
    insertFts.run(Number(inserted.lastInsertRowid), ...columns);
  }
  return units.length;
}

export function deleteSqliteSearchUnits(db: DatabaseSync, ref: ExactViewRef): number {
  const rows = db.prepare(`
    select search_unit_id from view_search_units_v2 where view_id = ? and revision = ?
  `).all(ref.view_id, ref.revision) as Array<{ search_unit_id: number }>;
  const deleteFts = db.prepare("delete from view_search_unit_fts_v2 where rowid = ?");
  for (const row of rows) deleteFts.run(Number(row.search_unit_id));
  db.prepare("delete from view_search_units_v2 where view_id = ? and revision = ?").run(ref.view_id, ref.revision);
  return rows.length;
}

export function sqliteSearchUnitsMatch(db: DatabaseSync, view: View): boolean {
  const expected = projectSqliteSearchUnits(view)
    .map(unit => ({
      ordinal: unit.ordinal,
      category: unit.category,
      expanded_path: unit.expanded_path,
      value_digest: unit.value_digest,
      columns: unitColumns(unit),
    }))
    .sort((left, right) => left.ordinal - right.ordinal || left.expanded_path.localeCompare(right.expanded_path));
  const rows = db.prepare(`
    select u.search_unit_id, u.ordinal, u.category, u.expanded_path, u.value_digest,
           f.title, f.text, f.identifiers, f.urls, f.timestamps, f.provenance
    from view_search_units_v2 u
    left join view_search_unit_fts_v2 f on f.rowid = u.search_unit_id
    where u.view_id = ? and u.revision = ?
    order by u.ordinal, u.expanded_path, u.search_unit_id
  `).all(view.id, view.revision) as UnitRow[];
  const actual = rows.map(row => ({
    ordinal: Number(row.ordinal),
    category: row.category,
    expanded_path: row.expanded_path,
    value_digest: row.value_digest,
    columns: [row.title, row.text, row.identifiers, row.urls, row.timestamps, row.provenance],
  }));
  return canonicalJson(expected) === canonicalJson(actual);
}

function resolveExpandedPath(root: JsonValue, pointer: string): Array<{ path: string; value: JsonValue }> {
  const tokens = pointer.slice(1).split("/").map(unescapePointerToken);
  let values: Array<{ path: string; value: JsonValue }> = [{ path: "", value: root }];
  for (const token of tokens) {
    const next: Array<{ path: string; value: JsonValue }> = [];
    for (const current of values) {
      if (Array.isArray(current.value)) {
        if (token === "*") {
          current.value.forEach((value, index) => next.push({ path: `${current.path}/${index}`, value }));
          continue;
        }
        if (!/^(0|[1-9]\d*)$/u.test(token)) continue;
        const selected = current.value[Number(token)];
        if (selected !== undefined) next.push({ path: `${current.path}/${token}`, value: selected });
        continue;
      }
      if (current.value !== null && typeof current.value === "object" && token !== "*") {
        const selected = current.value[token];
        if (selected !== undefined) next.push({ path: `${current.path}/${escapePointerToken(token)}`, value: selected });
      }
    }
    values = next;
  }
  return values;
}

function normalizeSearchUnitValue(field: ViewSearchProjectionField, value: JsonValue, view: View): string | undefined {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new TypeError(`Search projection ${field.category}:${field.path} for ${view.id}@${view.revision} resolved to a non-scalar value`);
  }
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  if (field.category === "url") {
    try {
      new URL(normalized);
    } catch (cause) {
      throw new TypeError(`Search projection ${field.path} for ${view.id}@${view.revision} is not a valid URL`, { cause });
    }
  }
  if (field.category === "timestamp") TimestampSchema.parse(normalized);
  return normalized;
}

function unitColumns(unit: SqliteSearchUnit): [string, string, string, string, string, string] {
  const values: [string, string, string, string, string, string] = ["", "", "", "", "", ""];
  values[categoryColumn(unit.category)] = unit.normalized_value;
  return values;
}

function categoryColumn(category: ViewSearchProjectionField["category"]): number {
  if (category === "title") return 0;
  if (category === "text") return 1;
  if (category === "identifier") return 2;
  if (category === "url") return 3;
  if (category === "timestamp") return 4;
  return 5;
}

function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}
