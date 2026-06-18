import type { StoredContextRecord, StoredContextView } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";

export const MEMORY_PROFILE_UPDATE_PROCESSOR_ID = "processor.memory_profile_update";
export const MEMORY_PROFILE_VIEW_TYPE = "memory.profile";
export const MEMORY_PREFERENCES_VIEW_TYPE = "memory.preferences";

export type MemoryProfileUpdateOptions = {
  dailyLimit?: number;
  feedbackLimit?: number;
  now?: Date;
};

export function createMemoryProfileUpdateProcessor(options: MemoryProfileUpdateOptions = {}): ProcessorDefinition {
  return {
    id: MEMORY_PROFILE_UPDATE_PROCESSOR_ID,
    title: "Memory Profile Update",
    version: "0.0.1",
    description: "Derives memory.profile and memory.preferences from memory.daily views and feedback observations.",
    consumes: {
      observations: ["feedback.*"],
      views: ["memory.daily"],
    },
    produces: { views: [MEMORY_PROFILE_VIEW_TYPE, MEMORY_PREFERENCES_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "background", autonomy: "draft", privacy: "private" },
    handler: memoryProfileUpdateHandler(options),
  };
}

export function memoryProfileUpdateHandler(options: MemoryProfileUpdateOptions = {}): ProcessorHandler {
  return (_input, context) => {
    const now = options.now ?? new Date();
    const dailyViews = context.store.listViews({ view_types: ["memory.daily"], active_only: true, limit: options.dailyLimit ?? 14 });
    const feedbackRecords = context.store.recent(options.feedbackLimit ?? 40, undefined, undefined)
      .filter((record: StoredContextRecord) => record.schema.name.startsWith("feedback."));

    const sourceViewIds = dailyViews.map((v: StoredContextView) => v.id);
    const sourceRecordIds = feedbackRecords.map((r: StoredContextRecord) => r.id);
    const generatedAt = now.toISOString();

    const summaries = dailyViews
      .map((v: StoredContextView) => typeof v.content?.summary === "string" ? v.content.summary : "")
      .filter(Boolean)
      .slice(0, 8);

    const profileView: ViewDraft = {
      id: "view:memory_profile:user",
      type: MEMORY_PROFILE_VIEW_TYPE,
      title: "Memory Profile",
      summary: summaries[0] ?? "User profile derived from daily memories.",
      status: "candidate",
      source_records: sourceRecordIds,
      source_views: sourceViewIds,
      compiler: { id: MEMORY_PROFILE_UPDATE_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Durable user profile derived from daily memories and explicit feedback.",
      scope: { type: "user" } as Record<string, unknown>,
      content: {
        summaries,
        daily_count: dailyViews.length,
        feedback_count: feedbackRecords.length,
        generated_at: generatedAt,
      },
      confidence: Math.min(0.9, 0.4 + dailyViews.length * 0.05),
      stability: "long_term",
      lossiness: "medium",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: generatedAt, algorithm: "memory-profile-update-v1" },
    };

    const editedFeedback = feedbackRecords.filter((r: StoredContextRecord) => r.schema.name === "feedback.output.edited");
    const dismissedFeedback = feedbackRecords.filter((r: StoredContextRecord) => r.schema.name === "feedback.view.dismissed");
    const preferences = [
      ...editedFeedback.slice(0, 5).map((r: StoredContextRecord) => ({
        type: "output_edit",
        title: r.content?.title ?? "Output edited",
        observed_at: r.time?.observed_at ?? r.created_at,
      })),
      ...dismissedFeedback.slice(0, 5).map((r: StoredContextRecord) => ({
        type: "view_dismissed",
        title: r.content?.title ?? "View dismissed",
        observed_at: r.time?.observed_at ?? r.created_at,
      })),
    ];

    const preferencesView: ViewDraft = {
      id: "view:memory_preferences:user",
      type: MEMORY_PREFERENCES_VIEW_TYPE,
      title: "Memory Preferences",
      summary: `${preferences.length} preference signal(s) from user feedback.`,
      status: "candidate",
      source_records: sourceRecordIds,
      source_views: sourceViewIds,
      compiler: { id: MEMORY_PROFILE_UPDATE_PROCESSOR_ID, version: "0.0.1", mode: "deterministic" },
      purpose: "Stable user preferences derived from feedback signals.",
      scope: { type: "user" } as Record<string, unknown>,
      content: {
        preferences,
        edit_count: editedFeedback.length,
        dismiss_count: dismissedFeedback.length,
        generated_at: generatedAt,
      },
      confidence: Math.min(0.9, 0.3 + feedbackRecords.length * 0.06),
      stability: "long_term",
      lossiness: "low",
      privacy: { level: "private", retention: "normal" },
      metadata: { generated_at: generatedAt, algorithm: "memory-profile-update-v1" },
    };

    return { views: [profileView, preferencesView] };
  };
}
