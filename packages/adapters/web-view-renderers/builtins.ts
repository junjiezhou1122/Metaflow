import type { WebRendererRegistration } from "./contracts.js";

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
  ];
}
