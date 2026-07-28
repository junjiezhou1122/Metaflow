import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { SCREENPIPE_TIMELINE_METHOD_IDS, SCREENPIPE_TIMELINE_WEB_RENDERER } from "@info/view-package-screenpipe-timeline/wire";
import { WebRendererRegistry, type RendererLifecycleEvent, type WebRendererDescriptor, type WebRendererInput } from "@info/web-view-renderers";
import {
  SCREENPIPE_AUDIO_RENDERER,
  SCREENPIPE_TIMELINE_RENDERER,
  createScreenpipeWebRendererRegistrations,
} from "@info/web-view-renderers/screenpipe";
import type { JsonValue, View } from "@info/view";
import { ViewExplorerOperationClient } from "./operation-client.js";

const registry = new WebRendererRegistry(createScreenpipeWebRendererRegistrations());
const legacyDescriptors: WebRendererDescriptor[] = [
  SCREENPIPE_TIMELINE_RENDERER,
  SCREENPIPE_AUDIO_RENDERER,
];

export function supportsViewRenderer(view: View | undefined): boolean {
  return Boolean(view && supportsViewSchema(view.schema.name));
}

export function supportsViewSchema(schemaName: string): boolean {
  return ["metaflow.screenpipe.timeline-index", "metaflow.screenpipe.timeline", "metaflow.screenpipe.audio"].includes(schemaName);
}

export function ViewRendererSurface({ view, client }: { view: View; client: ViewExplorerOperationClient }) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string>();
  const descriptors = useMemo(() => view.schema.name === "metaflow.screenpipe.timeline-index"
    ? [SCREENPIPE_TIMELINE_WEB_RENDERER]
    : legacyDescriptors, [view.schema.name, view.schema.version]);

  useEffect(() => {
    const node = container.current;
    if (!node) return;
    const abort = new AbortController();
    setState("loading"); setFailure(undefined); node.replaceChildren();
    const input = rendererInput(view);
    void registry.mount({
      descriptors,
      input,
      declared_method_ids: view.schema.name === "metaflow.screenpipe.timeline-index" ? SCREENPIPE_TIMELINE_METHOD_IDS : [],
      container: node,
      signal: abort.signal,
      services: {
        async resolveAsset() { throw new Error("Screenpipe query results use the authorized exact-View asset route"); },
        releaseAsset() {},
        async invokeMethod({ method_id, input: methodInput }, signal) {
          if (method_id === "inspect") return client.execute("view.get", { ref: input.view }, signal) as never;
          if (method_id === "entries") {
            const request = methodInput as { parameters?: JsonValue; page?: JsonValue };
            return client.execute("view.query", {
              request: {
                contract_version: 1,
                subject: input.view,
                profile: { id: "screenpipe.timeline.entries", version: 1 },
                parameters: request.parameters ?? {},
                page: request.page ?? { limit: 50 },
              },
            }, signal) as never;
          }
          throw new Error(`Unsupported Renderer Method: ${method_id}`);
        },
        async openLink(request) { window.open(request.href, request.disposition === "new_context" ? "_blank" : "_self", "noopener,noreferrer"); },
        emit(event: RendererLifecycleEvent) { window.dispatchEvent(new CustomEvent("metaflow:renderer-lifecycle", { detail: event })); },
        reportBackgroundError(error) { console.error("[view-renderer]", error); },
      },
    }).then(mounted => {
      if (abort.signal.aborted) return;
      setState("ready");
      abort.signal.addEventListener("abort", () => { void mounted.dispose(); }, { once: true });
    }).catch(error => {
      if (abort.signal.aborted) return;
      setFailure(error instanceof Error ? error.message : String(error)); setState("error");
    });
    return () => abort.abort();
  }, [client, descriptors, view]);

  return <section className="view-renderer-stage" aria-label="Rendered View"><div ref={container} className="view-renderer-container" />{state === "loading" && <div className="renderer-overlay"><LoaderCircle className="spin" size={20} />Loading View Renderer</div>}{state === "error" && <div className="renderer-overlay error"><AlertTriangle size={20} />{failure}</div>}</section>;
}

function rendererInput(view: View): WebRendererInput {
  return {
    contract_version: 1,
    view: { view_id: view.id, revision: view.revision },
    envelope: { contract_version: 1, name: view.name, purpose: view.purpose, schema: view.schema, role: view.role, time: view.time },
    representation: view.representation.form === "inline"
      ? { form: "inline", kind: view.representation.kind, ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}), value: view.representation.value }
      : { form: "external_reference", kind: view.representation.kind, ...(view.representation.media_type ? { media_type: view.representation.media_type } : {}), asset_id: view.materialization.primary.id },
    materializations: [], mode: "full",
  };
}
