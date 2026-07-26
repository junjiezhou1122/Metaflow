export type QueryableView = {
  view_type?: string;
  title?: string;
  summary?: string;
  purpose?: string;
  content?: unknown;
  metadata?: unknown;
};

export function viewMatchesQuery(view: QueryableView, query?: string): boolean {
  const terms = query?.split(/\s+/).map(term => term.trim().toLowerCase()).filter(Boolean).slice(0, 8) ?? [];
  if (!terms.length) return true;
  const hay = [
    view.view_type,
    view.title,
    view.summary,
    view.purpose,
    JSON.stringify(view.content ?? {}),
    JSON.stringify(view.metadata ?? {}),
  ].filter(Boolean).join("\n").toLowerCase();
  return terms.some(term => hay.includes(term));
}

export function filterViewsByQuery<T extends QueryableView>(views: T[], query?: string): T[] {
  if (!query?.trim()) return views;
  return views.filter(view => viewMatchesQuery(view, query));
}
