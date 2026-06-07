import type { StoredContextView } from "./types.js";

export function activeContextView(view: StoredContextView): boolean {
  if (view.status === "archived" || view.status === "rejected") return false;
  const now = Date.now();
  const validFrom = view.validity?.valid_from ? Date.parse(view.validity.valid_from) : undefined;
  if (validFrom !== undefined && Number.isFinite(validFrom) && validFrom > now) return false;
  const validUntil = view.validity?.valid_until ? Date.parse(view.validity.valid_until) : undefined;
  if (validUntil !== undefined && Number.isFinite(validUntil) && validUntil < now) return false;
  const staleAfter = view.validity?.stale_after ? Date.parse(view.validity.stale_after) : undefined;
  if (staleAfter !== undefined && Number.isFinite(staleAfter) && staleAfter < now) return false;
  return true;
}
