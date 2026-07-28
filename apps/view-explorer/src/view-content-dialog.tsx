import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import {
  PERSONAL_AUDIO_SCHEMA,
  PERSONAL_DAILY_SUMMARY_SCHEMA,
  PERSONAL_TIMELINE_SCHEMA,
  personalActivityManifest,
} from "@info/view-package-personal-activity/browser";
import { WebRendererError, WebRendererRegistry, type RendererLifecycleEvent, type WebRendererInput } from "@info/web-view-renderers";
import { createPersonalActivityWebRendererRegistrations } from "@info/web-view-renderers/personal-activity";
import {
  SCREENPIPE_AUDIO_RENDERER,
  SCREENPIPE_TIMELINE_RENDERER,
  createScreenpipeWebRendererRegistrations,
} from "@info/web-view-renderers/screenpipe";
import { refKey, type View, type ViewGraphProjectionNode } from "./contracts.js";

const viewRendererRegistry = new WebRendererRegistry([
  ...createPersonalActivityWebRendererRegistrations(),
  ...createScreenpipeWebRendererRegistrations(),
]);
const specializedSchemaKeys = new Set([
  PERSONAL_AUDIO_SCHEMA,
  PERSONAL_TIMELINE_SCHEMA,
  PERSONAL_DAILY_SUMMARY_SCHEMA,
  SCREENPIPE_AUDIO_RENDERER.schema,
  SCREENPIPE_TIMELINE_RENDERER.schema,
]
  .map(schema => `${schema.name}@${schema.version}`));

const MARKDOWN_ELEMENTS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "li", "ol", "p", "pre", "strong", "table", "tbody", "td", "th", "thead", "tr", "ul",
] as const;

const markdownComponents: Components = {
  a({ href, children }) {
    const safe = href && safeMarkdownUrl(href);
    return safe
      ? <a href={safe} target="_blank" rel="noreferrer">{children}</a>
      : <span>{children}</span>;
  },
  img({ alt }) {
    return <span role="note">{alt ? `[Image: ${alt}]` : "[Image omitted]"}</span>;
  },
};

export function ViewContentDialog(props: {
  node: ViewGraphProjectionNode;
  view?: View;
  loading: boolean;
  neighborCount: number;
  close(): void;
  expand(): void;
  selectNeighbor(position: "previous" | "next"): void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [props.node.ref.view_id, props.node.ref.revision]);

  const key = refKey(props.node.ref);
  return (
    <div className="view-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) props.close(); }}>
      <section className="view-dialog" role="dialog" aria-modal="true" aria-labelledby="view-dialog-title">
        <header className="view-dialog-header">
          <div className="view-dialog-identity detail-heading">
            <span className={`role-pill role-${props.node.role}`}>{props.node.role}</span>
            <div>
              <h1 id="view-dialog-title">{props.node.name}</h1>
              <code title={key}>{key}</code>
            </div>
          </div>
          <button ref={closeRef} type="button" className="icon-button dialog-close" onClick={props.close} aria-label="Close View"><X size={20} /></button>
        </header>

        <div className="view-dialog-layout">
          <main className="view-content" aria-label="View content">
            {props.view ? <RepresentationContent view={props.view} /> : <div className="content-loading" role="status">Loading View content</div>}
          </main>

          <aside className="view-information" aria-label="View information">
            <section>
              <h2>About</h2>
              <dl>
                <dt>Schema</dt><dd>{props.node.schema.name}@{props.node.schema.version}</dd>
                <dt>Purpose</dt><dd>{props.node.purpose}</dd>
                <dt>Format</dt><dd>{props.node.representation.kind}{props.node.representation.media_type ? ` · ${props.node.representation.media_type}` : ""}</dd>
                <dt>Created</dt><dd>{formatTime(props.node.time.created_at)}</dd>
              </dl>
            </section>
            <section className="provenance">
              <h2>Provenance</h2>
              {props.view ? <dl>
                <dt>Actor</dt><dd>{props.view.provenance.actor}</dd>
                <dt>Inputs</dt><dd>{props.view.provenance.inputs.length
                  ? <details className="provenance-inputs"><summary>{props.view.provenance.inputs.length} exact input Views</summary><div>{props.view.provenance.inputs.map(refKey).join(", ")}</div></details>
                  : "None"}</dd>
                {props.view.provenance.operator_run_id && <><dt>Run</dt><dd>{props.view.provenance.operator_run_id}</dd></>}
                {props.view.provenance.capture && <><dt>Connector</dt><dd>{props.view.provenance.capture.connector}</dd></>}
              </dl> : <span className="muted">Loading provenance</span>}
            </section>
            <button type="button" className="command" onClick={props.expand} disabled={props.loading}><Plus size={15} />Reveal connected Views</button>
            <div className="neighbor-controls" role="group" aria-label="Neighbor navigation">
              <button type="button" className="icon-button" disabled={!props.neighborCount} onClick={() => props.selectNeighbor("previous")} aria-label="Previous neighbor"><ChevronLeft size={16} /></button>
              <output>{props.neighborCount} connected</output>
              <button type="button" className="icon-button" disabled={!props.neighborCount} onClick={() => props.selectNeighbor("next")} aria-label="Next neighbor"><ChevronRight size={16} /></button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}

function RepresentationContent({ view }: { view: View }): ReactNode {
  if (specializedSchemaKeys.has(`${view.schema.name}@${view.schema.version}`)) {
    return <SpecializedViewRenderer view={view} />;
  }
  if (view.representation.form !== "inline") {
    return <section className="external-content"><h2>External content</h2><p>This View retains an external reference. Its content must be materialized through an authorized View operation.</p><RawValue value={view.representation} /></section>;
  }
  const markdown = markdownValue(view.representation.value, view.representation.kind, view.representation.media_type);
  if (markdown !== undefined) {
    return <article className="view-markdown"><ReactMarkdown allowedElements={[...MARKDOWN_ELEMENTS]} components={markdownComponents} remarkPlugins={[remarkGfm]} skipHtml unwrapDisallowed urlTransform={safeMarkdownUrlTransform}>{markdown}</ReactMarkdown></article>;
  }
  if (typeof view.representation.value === "string") {
    return <pre className="view-plain-text">{view.representation.value}</pre>;
  }
  return <RawValue value={view.representation.value} />;
}

function SpecializedViewRenderer({ view }: { view: View }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    const container = containerRef.current;
    if (!container) throw new Error("Product View Renderer container is unavailable");
    const controller = new AbortController();
    setFailure(undefined);
    const descriptors = [...personalActivityManifest.renderers, SCREENPIPE_AUDIO_RENDERER, SCREENPIPE_TIMELINE_RENDERER]
      .filter(renderer => renderer.schema.name === view.schema.name && renderer.schema.version === view.schema.version)
      .filter(renderer => renderer.surfaces.includes("web"));
    const declaredMethodIds = personalActivityManifest.methods
      .filter(method => method.schema.name === view.schema.name && method.schema.version === view.schema.version)
      .map(method => method.id);
    void viewRendererRegistry.mount({
      descriptors,
      input: productRendererInput(view),
      declared_method_ids: declaredMethodIds,
      container,
      signal: controller.signal,
      services: {
        async resolveAsset() { throw new Error("View Renderer has no authorized external asset"); },
        releaseAsset(asset) { URL.revokeObjectURL(asset.object_url); },
        async invokeMethod() { throw new Error("View Renderer exposes no interactive Method host"); },
        openLink(request) {
          const opened = window.open(request.href, request.disposition === "new_context" ? "_blank" : "_self", "noopener,noreferrer");
          if (!opened) throw new Error("Browser refused the authorized Renderer link");
        },
        emit: recordRendererLifecycle,
        reportBackgroundError: reportRendererBackgroundError,
      },
    }).catch(error => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => {
      queueMicrotask(() => controller.abort(new DOMException("View navigation disposed Renderer", "AbortError")));
    };
  }, [view.id, view.revision]);

  return <div className="product-renderer-shell">
    <div ref={containerRef} className="product-renderer-mount" />
    {failure && <div className="renderer-failure" role="alert" data-error-code="product_renderer_failed">{failure}</div>}
  </div>;
}

function productRendererInput(view: View): WebRendererInput {
  if (view.representation.form !== "inline") {
    throw new TypeError(`Product View ${view.id}@${view.revision} requires an inline Representation`);
  }
  return {
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
}

function recordRendererLifecycle(event: RendererLifecycleEvent): void {
  const target = window as typeof window & { __METAFLOW_RENDERER_EVENTS__?: RendererLifecycleEvent[] };
  target.__METAFLOW_RENDERER_EVENTS__ = [...(target.__METAFLOW_RENDERER_EVENTS__ ?? []), event];
  window.dispatchEvent(new CustomEvent("metaflow:renderer-lifecycle", { detail: event }));
}

function reportRendererBackgroundError(error: Error): void {
  if (error instanceof WebRendererError && error.code === "mount_failed" && error.details.aborted === true) {
    const target = window as typeof window & { __METAFLOW_RENDERER_CANCELLATIONS__?: string[] };
    target.__METAFLOW_RENDERER_CANCELLATIONS__ = [...(target.__METAFLOW_RENDERER_CANCELLATIONS__ ?? []), error.message];
    window.dispatchEvent(new CustomEvent("metaflow:renderer-background-cancelled", { detail: { code: error.code } }));
    return;
  }
  console.error("Product View Renderer background failure", error);
}

function RawValue({ value }: { value: unknown }) {
  return <pre className="view-json">{JSON.stringify(value, null, 2)}</pre>;
}

function markdownValue(value: unknown, kind: string, mediaType?: string): string | undefined {
  const markdownKind = kind.toLowerCase().includes("markdown") || mediaType?.toLowerCase().startsWith("text/markdown");
  if (!markdownKind) return undefined;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const markdown = (value as Record<string, unknown>).markdown;
    if (typeof markdown === "string") return markdown;
  }
  return undefined;
}

const safeMarkdownUrlTransform: UrlTransform = url => safeMarkdownUrl(url) ?? "";

function safeMarkdownUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "mailto:") || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
