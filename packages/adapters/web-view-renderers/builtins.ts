import type { WebRendererRegistration } from "./contracts.js";
import {
  PERSONAL_AUDIO_RENDERER_ID,
  PERSONAL_DAILY_SUMMARY_RENDERER_ID,
  PERSONAL_TIMELINE_RENDERER_ID,
  createPersonalActivityWebRendererRegistrations,
} from "./personal-activity.js";
import {
  SCREENPIPE_AUDIO_RENDERER_ID,
  SCREENPIPE_TIMELINE_RENDERER_ID,
  createScreenpipeWebRendererRegistrations,
} from "./screenpipe.js";

export { PERSONAL_AUDIO_RENDERER_ID, PERSONAL_DAILY_SUMMARY_RENDERER_ID, PERSONAL_TIMELINE_RENDERER_ID };
export { SCREENPIPE_AUDIO_RENDERER_ID, SCREENPIPE_TIMELINE_RENDERER_ID };

export const JSON_RENDERER_ID = { id: "renderer.web.json", version: 1, abi_version: 1 } as const;
export const MARKDOWN_RENDERER_ID = { id: "renderer.web.markdown", version: 1, abi_version: 1 } as const;
export const IMAGE_RENDERER_ID = { id: "renderer.web.image", version: 1, abi_version: 1 } as const;
export const TABLE_RENDERER_ID = { id: "renderer.web.table", version: 1, abi_version: 1 } as const;

export function createBuiltInWebRendererRegistrations(): WebRendererRegistration[] {
  return [
    {
      descriptor: JSON_RENDERER_ID,
      load: async () => (await import("./renderers/json.js")).jsonRendererFactory,
    },
    {
      descriptor: MARKDOWN_RENDERER_ID,
      load: async () => (await import("./renderers/markdown.js")).markdownRendererFactory,
    },
    {
      descriptor: IMAGE_RENDERER_ID,
      load: async () => (await import("./renderers/image.js")).imageRendererFactory,
    },
    {
      descriptor: TABLE_RENDERER_ID,
      load: async () => (await import("./renderers/table.js")).tableRendererFactory,
    },
    ...createPersonalActivityWebRendererRegistrations(),
    ...createScreenpipeWebRendererRegistrations(),
  ];
}
