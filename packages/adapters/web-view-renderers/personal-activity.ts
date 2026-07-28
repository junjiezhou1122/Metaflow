import type { WebRendererRegistration } from "./contracts.js";

export const PERSONAL_AUDIO_RENDERER_ID = { id: "renderer.personal.audio", version: 1, abi_version: 1 } as const;
export const PERSONAL_TIMELINE_RENDERER_ID = { id: "renderer.personal.timeline", version: 1, abi_version: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_RENDERER_ID = { id: "renderer.personal.daily-summary", version: 1, abi_version: 1 } as const;

export function createPersonalActivityWebRendererRegistrations(): WebRendererRegistration[] {
  return [
    {
      descriptor: PERSONAL_AUDIO_RENDERER_ID,
      load: async () => (await import("./renderers/personal-audio.js")).personalAudioRendererFactory,
    },
    {
      descriptor: PERSONAL_TIMELINE_RENDERER_ID,
      load: async () => (await import("./renderers/personal-timeline.js")).personalTimelineRendererFactory,
    },
    {
      descriptor: PERSONAL_DAILY_SUMMARY_RENDERER_ID,
      load: async () => (await import("./renderers/personal-daily-summary.js")).personalDailySummaryRendererFactory,
    },
  ];
}
