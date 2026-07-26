import type { LlmOptions, StoredContextRecord, StoredContextView } from "@info/core";
import type { ContextStore } from "@info/core";
import type { ContextSourceReference } from "./types.js";

export type BuildContextWindowOptions = {
  // Time window in minutes to look back (default: 60)
  windowMinutes?: number;
  // Maximum tokens/characters budget (approximate)
  maxTokens?: number;
  // Specific source types to include (default includes observation and derived)
  allowedSourceTypes?: string[];
};

export type ContextWindowSnapshot = {
  records: StoredContextRecord[];
  views: StoredContextView[];
  sources: ContextSourceReference[];
  // Summary of what was included / excluded
  diagnostics: {
    totalRecordsScanned: number;
    totalRecordsIncluded: number;
    totalViewsIncluded: number;
    excludedRecordTypes: string[];
    timeRange: { start: string; end: string };
  };
};

/**
 * Gather bounded recent context from the store.
 * Only includes records that are not explicitly blocked by privacy rules.
 */
export function buildContextWindow(
  store: ContextStore,
  options: BuildContextWindowOptions = {}
): ContextWindowSnapshot {
  const now = new Date();
  const windowMinutes = options.windowMinutes ?? 60;
  const startDate = new Date(now.getTime() - windowMinutes * 60_000);
  const startIso = startDate.toISOString();
  const endIso = now.toISOString();

  const allRecords = store.recent(500, undefined, { minutes: windowMinutes });

  // Exclude sources with explicit do-not-store or secret privacy levels
  const records: StoredContextRecord[] = [];
  const excludedRecordTypes = new Set<string>();

  for (const record of allRecords) {
    if (record.privacy?.retention === "do_not_store" || record.privacy?.level === "secret") {
      excludedRecordTypes.add(record.schema.name);
      continue;
    }
    records.push(record);
  }

  // Include relevant views from the same time window (heuristic: last N views)
  const views = store.listViews({ limit: 50, active_only: true })
    .filter((view) => {
      const updated = new Date(view.updated_at);
      return updated >= startDate && updated <= now;
    });

  const sources: ContextSourceReference[] = [
    ...records.map((r) => ({
      kind: "record" as const,
      id: r.id,
      type: r.schema.name,
      sourceType: r.source.type,
      observedAt: r.time?.observed_at ?? r.created_at,
      title: r.content?.title,
    })),
    ...views.map((v) => ({
      kind: "view" as const,
      id: v.id,
      type: v.view_type,
      sourceType: "derived_view",
      observedAt: v.updated_at ?? v.created_at,
      title: v.title,
    })),
  ];

  return {
    records,
    views,
    sources,
    diagnostics: {
      totalRecordsScanned: allRecords.length,
      totalRecordsIncluded: records.length,
      totalViewsIncluded: views.length,
      excludedRecordTypes: [...excludedRecordTypes],
      timeRange: { start: startIso, end: endIso },
    },
  };
}
