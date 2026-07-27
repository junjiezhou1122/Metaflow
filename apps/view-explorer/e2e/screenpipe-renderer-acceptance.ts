import {
  WebRendererRegistry,
  type RendererHostServices,
  type RendererLifecycleEvent,
  type WebRendererInput,
} from "@info/web-view-renderers";
import { createBuiltInWebRendererRegistrations } from "@info/web-view-renderers/builtins";
import {
  SCREENPIPE_AUDIO_RENDERER,
  SCREENPIPE_TIMELINE_RENDERER,
} from "@info/web-view-renderers/screenpipe";
import { ViewRevisionSchema } from "../src/contracts.js";
import type { PersonalizedRendererAcceptanceEvidence } from "./personalized-renderer-acceptance.js";

export async function runScreenpipeRendererAcceptance(
  authorizedViewValue: unknown,
): Promise<PersonalizedRendererAcceptanceEvidence> {
  const view = ViewRevisionSchema.parse(authorizedViewValue);
  if (view.representation.form !== "inline") throw new TypeError("Screenpipe Renderer acceptance requires inline evidence");
  const descriptor = view.schema.name === "metaflow.screenpipe.timeline"
    ? SCREENPIPE_TIMELINE_RENDERER
    : view.schema.name === "metaflow.screenpipe.audio"
      ? SCREENPIPE_AUDIO_RENDERER
      : undefined;
  if (!descriptor) throw new TypeError(`Unsupported Screenpipe Renderer schema: ${view.schema.name}@${view.schema.version}`);
  const input: WebRendererInput = {
    contract_version: 1,
    view: { view_id: view.id, revision: view.revision },
    envelope: {
      contract_version: 1,
      name: view.name,
      purpose: view.purpose,
      schema: view.schema,
      role: view.role,
      time: view.time,
    },
    representation: {
      form: "inline",
      kind: view.representation.kind,
      ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}),
      value: view.representation.value,
    },
    materializations: [],
    mode: "full",
  };
  const events: RendererLifecycleEvent[] = [];
  let tick = 0;
  const services: RendererHostServices = {
    resolveAsset: async () => { throw new Error("Screenpipe evidence Renderer requested an undeclared asset"); },
    releaseAsset: async () => undefined,
    invokeMethod: async () => { throw new Error("Screenpipe evidence Renderer invoked an undeclared Method"); },
    openLink: async () => { throw new Error("Screenpipe evidence Renderer opened an undeclared link"); },
    emit: event => { events.push(event); },
    reportBackgroundError: error => { throw error; },
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    monotonicNow: () => ++tick,
  };
  const container = document.createElement("section");
  document.body.append(container);
  const registry = new WebRendererRegistry(createBuiltInWebRendererRegistrations());
  let mounted: Awaited<ReturnType<WebRendererRegistry["mount"]>> | undefined;
  let disposed = false;
  try {
    mounted = await registry.mount({
      descriptors: [descriptor],
      input,
      declared_method_ids: [],
      container,
      services,
      signal: new AbortController().signal,
    });
    const renderedElementCount = container.querySelectorAll("*").length;
    if (renderedElementCount === 0 || !container.textContent?.includes("Screenpipe evidence")) {
      throw new Error("Screenpipe evidence Renderer mounted without visible evidence content");
    }
    disposed = true;
    await mounted.dispose();
    const names = events.map(event => event.event);
    if (!names.includes("renderer.ready") || !names.includes("renderer.dispose.started") || !names.includes("renderer.dispose.succeeded")) {
      throw new Error("Screenpipe evidence Renderer lifecycle was incomplete");
    }
    return {
      descriptor: { id: mounted.descriptor.id, version: mounted.descriptor.version, abi_version: mounted.descriptor.abi_version },
      rendered_content_exists: true,
      rendered_element_count: renderedElementCount,
      lifecycle_event_count: events.length,
      ready: true,
      dispose_started: true,
      dispose_succeeded: true,
    };
  } finally {
    if (mounted && !disposed) await mounted.dispose();
    container.remove();
  }
}
