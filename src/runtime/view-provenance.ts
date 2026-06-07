import type { ContextStore } from "@info/core";
import type { StoredContextRecord, StoredContextView } from "@info/core";
import { activeContextView } from "@info/core";

export type ViewProvenanceResult = {
  ok: boolean;
  view_id: string;
  root?: StoredContextView;
  views: StoredContextView[];
  records: StoredContextRecord[];
  diagnostics: {
    max_depth: number;
    truncated: boolean;
    missing_view_ids: string[];
    missing_record_ids: string[];
    inactive_view_ids: string[];
  };
};

export function collectViewProvenance(store: ContextStore, viewId: string, maxDepth = 3): ViewProvenanceResult {
  const root = store.getView(viewId);
  const views = new Map<string, StoredContextView>();
  const records = new Map<string, StoredContextRecord>();
  const missingViewIds = new Set<string>();
  const missingRecordIds = new Set<string>();
  const inactiveViewIds = new Set<string>();
  let truncated = false;

  function visit(view: StoredContextView, depth: number) {
    if (views.has(view.id)) return;
    views.set(view.id, view);

    for (const recordId of view.source_records ?? []) {
      const record = store.getRecord(recordId);
      if (!record) missingRecordIds.add(recordId);
      else if (isViewProvenanceRecord(record)) records.set(record.id, record);
    }

    for (const sourceViewId of view.source_views ?? []) {
      if (depth >= maxDepth) {
        truncated = true;
        continue;
      }
      const sourceView = store.getView(sourceViewId);
      if (!sourceView) {
        missingViewIds.add(sourceViewId);
        continue;
      }
      if (!activeContextView(sourceView)) {
        inactiveViewIds.add(sourceView.id);
        continue;
      }
      visit(sourceView, depth + 1);
    }
  }

  if (root) visit(root, 0);
  else missingViewIds.add(viewId);

  return {
    ok: Boolean(root),
    view_id: viewId,
    root,
    views: [...views.values()],
    records: [...records.values()],
    diagnostics: {
      max_depth: maxDepth,
      truncated,
      missing_view_ids: [...missingViewIds],
      missing_record_ids: [...missingRecordIds],
      inactive_view_ids: [...inactiveViewIds],
    },
  };
}

function isViewProvenanceRecord(record: StoredContextRecord): boolean {
  return /^(observation|feedback)(\.|$)/.test(record.schema.name);
}
