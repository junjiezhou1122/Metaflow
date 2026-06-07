import { activeContextView } from "./view-lifecycle.js";
import type { StoredContextView } from "./types.js";

export type SurfacingPreferences = {
  show_more_view_types: string[];
  show_less_view_types: string[];
  source_view_ids: string[];
};

export function surfacingPreferencesFromMemoryViews(memories: StoredContextView[]): SurfacingPreferences {
  const activeMemories = memories
    .filter(activeContextView)
    .filter(memory => (memory.confidence ?? 0) >= 0.5);
  const effectiveMemories = activeMemories.filter(memory =>
    (memory.content?.preference === "show_more" || memory.content?.preference === "show_less") &&
    typeof memory.content?.target_view_type === "string" &&
    Boolean(memory.content.target_view_type.trim()),
  );
  const showLessTypes = new Set(
    effectiveMemories
      .filter(memory => memory.content?.preference === "show_less")
      .map(memory => memory.content?.target_view_type as string),
  );
  const showMoreTypes = new Set(
    effectiveMemories
      .filter(memory => memory.content?.preference === "show_more")
      .map(memory => memory.content?.target_view_type as string),
  );
  return {
    show_more_view_types: [...showMoreTypes].sort(),
    show_less_view_types: [...showLessTypes].sort(),
    source_view_ids: effectiveMemories.map(memory => memory.id).sort(),
  };
}

export function rankViewsForSurfacing<T extends { view_type: string; updated_at?: string }>(views: T[], preferences: SurfacingPreferences): T[] {
  const showMoreTypes = new Set(preferences.show_more_view_types);
  const showLessTypes = new Set(preferences.show_less_view_types);
  if (!showMoreTypes.size && !showLessTypes.size) return views;
  return [...views].sort((a, b) => {
    const preference = viewSurfacingRank(a.view_type, showMoreTypes, showLessTypes) - viewSurfacingRank(b.view_type, showMoreTypes, showLessTypes);
    if (preference !== 0) return preference;
    return Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? "");
  });
}

function viewSurfacingRank(viewType: string, showMoreTypes: Set<string>, showLessTypes: Set<string>): number {
  if (showMoreTypes.has(viewType)) return -1;
  if (showLessTypes.has(viewType)) return 1;
  return 0;
}
