import type { ExactViewRef } from "./contracts.js";

export const PRODUCT_VIEWS_FIXTURE_ID = "product-views" as const;

export const PRODUCT_VIEW_REFS = {
  daily_summary: { view_id: "view:personal:summary:2026-07-27", revision: 1 },
  timeline: { view_id: "view:personal:timeline:2026-07-27", revision: 1 },
  audio_design: { view_id: "view:personal:audio:design-conversation", revision: 1 },
  audio_scope: { view_id: "view:personal:audio:implementation-focus", revision: 1 },
} as const satisfies Record<string, ExactViewRef>;
