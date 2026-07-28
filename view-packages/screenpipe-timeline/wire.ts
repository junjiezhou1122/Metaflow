export const SCREENPIPE_TIMELINE_WEB_RENDERER = {
  id: "renderer.screenpipe.timeline",
  version: 1,
  abi_version: 1,
  schema: { name: "metaflow.screenpipe.timeline-index", version: 1 },
  surfaces: ["web"],
  representation_kinds: ["screenpipe_timeline_index"],
  media_types: ["application/json"],
  priority: 100,
} as const;

export const SCREENPIPE_TIMELINE_METHOD_IDS = ["inspect", "entries"] as const;
