import {
  WebRendererRegistry,
  type RendererHostServices,
  type RendererLifecycleEvent,
  type WebRendererDescriptor,
  type WebRendererInput,
} from "@info/web-view-renderers";
import {
  JSON_RENDERER_ID,
  createBuiltInWebRendererRegistrations,
} from "@info/web-view-renderers/builtins";
import { ViewRevisionSchema } from "../src/contracts.js";

const WORKING_STATE_RENDERER: WebRendererDescriptor = {
  ...JSON_RENDERER_ID,
  schema: { name: "personal.working_state", version: 1 },
  surfaces: ["web"],
  representation_kinds: ["agent_output"],
  priority: 100,
};

export type PersonalizedRendererAcceptanceEvidence = {
  descriptor: {
    id: string;
    version: number;
    abi_version: number;
  };
  rendered_content_exists: true;
  rendered_element_count: number;
  lifecycle_event_count: number;
  ready: true;
  dispose_started: true;
  dispose_succeeded: true;
};

export async function runPersonalizedRendererAcceptance(
  authorizedViewValue: unknown,
): Promise<PersonalizedRendererAcceptanceEvidence> {
  const authorizedView = ViewRevisionSchema.parse(authorizedViewValue);
  if (authorizedView.representation.form !== "inline") {
    throw new TypeError("Personalized Renderer acceptance requires an inline working-state View");
  }
  const input: WebRendererInput = {
    contract_version: 1,
    view: { view_id: authorizedView.id, revision: authorizedView.revision },
    envelope: {
      contract_version: 1,
      name: authorizedView.name,
      purpose: authorizedView.purpose,
      schema: authorizedView.schema,
      role: authorizedView.role,
      time: authorizedView.time,
    },
    representation: {
      form: "inline",
      kind: authorizedView.representation.kind,
      ...(authorizedView.representation.media_type
        ? { media_type: authorizedView.representation.media_type }
        : {}),
      value: authorizedView.representation.value,
    },
    materializations: [],
    mode: "full",
  };
  const events: RendererLifecycleEvent[] = [];
  let monotonicTick = 0;
  const services: RendererHostServices = {
    resolveAsset: async () => { throw new Error("Personalized JSON Renderer requested an undeclared asset"); },
    releaseAsset: async () => undefined,
    invokeMethod: async () => { throw new Error("Personalized JSON Renderer invoked an undeclared Method"); },
    openLink: async () => { throw new Error("Personalized JSON Renderer opened an undeclared link"); },
    emit: event => { events.push(event); },
    reportBackgroundError: error => { throw error; },
    now: () => new Date("2026-07-27T00:00:00.000Z"),
    monotonicNow: () => ++monotonicTick,
  };
  const container = document.createElement("section");
  container.setAttribute("data-personalized-renderer-acceptance", "true");
  document.body.append(container);

  const registry = new WebRendererRegistry(createBuiltInWebRendererRegistrations());
  const controller = new AbortController();
  let mounted: Awaited<ReturnType<WebRendererRegistry["mount"]>> | undefined;
  let disposalAttempted = false;
  let primaryFailure: unknown;
  try {
    mounted = await registry.mount({
      descriptors: [WORKING_STATE_RENDERER],
      input,
      declared_method_ids: [],
      container,
      services,
      signal: controller.signal,
    });
    const renderedElementCount = container.querySelectorAll("*").length;
    const renderedContentExists = renderedElementCount > 0 && (container.textContent?.trim().length ?? 0) > 0;
    if (!renderedContentExists) throw new Error("Personalized Web Renderer mounted without visible content");

    disposalAttempted = true;
    await mounted.dispose();
    const eventNames = events.map(event => event.event);
    const ready = eventNames.includes("renderer.ready");
    const disposeStarted = eventNames.includes("renderer.dispose.started");
    const disposeSucceeded = eventNames.includes("renderer.dispose.succeeded");
    if (!ready || !disposeStarted || !disposeSucceeded) {
      throw new Error("Personalized Web Renderer lifecycle was incomplete");
    }
    return {
      descriptor: {
        id: mounted.descriptor.id,
        version: mounted.descriptor.version,
        abi_version: mounted.descriptor.abi_version,
      },
      rendered_content_exists: true,
      rendered_element_count: renderedElementCount,
      lifecycle_event_count: events.length,
      ready: true,
      dispose_started: true,
      dispose_succeeded: true,
    };
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    try {
      if (mounted && !disposalAttempted) {
        disposalAttempted = true;
        await mounted.dispose();
      }
    } catch (cleanupFailure) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, cleanupFailure],
          "Personalized Web Renderer acceptance and cleanup both failed",
        );
      }
      throw cleanupFailure;
    } finally {
      container.remove();
    }
  }
}
