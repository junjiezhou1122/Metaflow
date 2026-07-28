import type { WebRendererDescriptor, WebRendererRegistration } from "./contracts.js";

export const SCREENPIPE_AUDIO_RENDERER_ID = { id: "renderer.screenpipe.audio", version: 1, abi_version: 1 } as const;
export const SCREENPIPE_TIMELINE_RENDERER_ID = { id: "renderer.screenpipe.timeline", version: 1, abi_version: 1 } as const;

export const SCREENPIPE_AUDIO_RENDERER: WebRendererDescriptor = {
  ...SCREENPIPE_AUDIO_RENDERER_ID,
  schema: { name: "metaflow.screenpipe.audio", version: 1 },
  surfaces: ["web"],
  representation_kinds: ["screenpipe_audio"],
  media_types: ["application/json"],
  priority: 100,
};

export const SCREENPIPE_TIMELINE_RENDERER: WebRendererDescriptor = {
  ...SCREENPIPE_TIMELINE_RENDERER_ID,
  schema: { name: "metaflow.screenpipe.timeline", version: 1 },
  surfaces: ["web"],
  representation_kinds: ["screenpipe_timeline"],
  media_types: ["application/json"],
  priority: 100,
};

export function createScreenpipeWebRendererRegistrations(): WebRendererRegistration[] {
  return [
    {
      descriptor: SCREENPIPE_AUDIO_RENDERER_ID,
      load: async () => (await import("./renderers/screenpipe-audio.js")).screenpipeAudioRendererFactory,
    },
    {
      descriptor: SCREENPIPE_TIMELINE_RENDERER_ID,
      load: async () => (await import("./renderers/screenpipe.js")).screenpipeViewRendererFactory,
    },
  ];
}
