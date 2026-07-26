import type { ContextStore, StoredContextRecord } from "@info/core";
import type { ProcessorDefinition, ProcessorHandler, ViewDraft } from "../types.js";
import { buildScreenpipeSurfaceView, SurfaceCaptureOptions } from "./screenpipe-surface.js";

export const SCREENPIPE_SURFACE_PROCESSOR_ID = "processor.screenpipe_surface";
export const SCREENPIPE_SURFACE_VIEW_TYPE = "screenpipe.surface";

export type ScreenpipeSurfaceProcessorOptions = SurfaceCaptureOptions & {
  windowMinutes?: number;
  recordLimit?: number;
  now?: Date;
};

export function createScreenpipeSurfaceProcessor(options: ScreenpipeSurfaceProcessorOptions = {}): ProcessorDefinition {
  return {
    id: SCREENPIPE_SURFACE_PROCESSOR_ID,
    title: "Screenpipe Non-Browser Surface",
    version: "0.0.1",
    description: "Builds an non-browser surface state view from Screenpipe OCR/screenshot observations, preferring OCR over vision and filtering self-observation noise.",
    consumes: {
      observations: [
        "observation.screenpipe_*",
        "observation.screenpipe_activity",
        "observation.screenpipe_activity_summary",
        "observation.screenpipe_input_event",
        "observation.screenpipe_audio",
        "observation.screenpipe_workspace_signal",
      ],
    },
    produces: { views: [SCREENPIPE_SURFACE_VIEW_TYPE] },
    runtime: { kind: "local" },
    policy: { speed: "reflex", autonomy: "draft", privacy: "private" },
    handler: screenpipeSurfaceHandler(options),
  };
}

export function screenpipeSurfaceHandler(options: ScreenpipeSurfaceProcessorOptions = {}): ProcessorHandler {
  return (input, context) => {
    const records = collectScreenpipeRecords(context.store, options);
    const seed = input.observation && isScreenpipeRecord(input.observation) ? input.observation : undefined;
    if (seed && !records.some(r => r.id === seed.id)) {
      records.unshift(seed);
    }

    const result = buildScreenpipeSurfaceView(records, {
      preferOcr: options.preferOcr ?? true,
      filterNoise: options.filterNoise ?? true,
      visionLlmRequired: options.visionLlmRequired ?? true,
      projectHints: options.projectHints,
      dryRun: options.dryRun,
    });

    if (!result.ok) {
      return {
        views: [],
        diagnostics: {
          error: result.error,
          capture_mode: result.capture_mode,
          vision_used: result.vision_used,
          noise_filtered: result.noise_filtered,
          privacy_level: result.privacy_level,
        },
      };
    }

    return {
      views: [{ ...result.view, type: SCREENPIPE_SURFACE_VIEW_TYPE }],
      diagnostics: {
        capture_mode: result.capture_mode,
        vision_used: result.vision_used,
        noise_filtered: result.noise_filtered,
        privacy_level: result.privacy_level,
      },
    };
  };
}

function collectScreenpipeRecords(store: Pick<ContextStore, "recent">, options: ScreenpipeSurfaceProcessorOptions): StoredContextRecord[] {
  const windowMinutes = options.windowMinutes ?? 10;
  const recordLimit = options.recordLimit ?? 80;
  const now = options.now ?? new Date();
  const timeWindow = { minutes: windowMinutes };
  return store.recent(recordLimit, undefined, timeWindow).filter(isScreenpipeRecord);
}

function isScreenpipeRecord(record: StoredContextRecord): boolean {
  return record.source.type === "screenpipe" || record.schema.name.startsWith("observation.screenpipe_");
}
