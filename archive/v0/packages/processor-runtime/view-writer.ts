import { createHash } from "node:crypto";
import type { ContextRecord, ContextStore, ContextView, StoredContextView } from "@info/core";
import { builtinViewSpecs, viewStorageFor, type ViewStorageSpec } from "@info/view-system";
import type { ProcessorDefinition, ViewDraft, WriteViewDraftContext } from "./types.js";

const VIEW_STORAGE_BY_TYPE = new Map(builtinViewSpecs().map(spec => [spec.view_type, viewStorageFor(spec)] as const));

export function writeViewDrafts(
  store: ContextStore,
  drafts: ViewDraft[] = [],
  context: WriteViewDraftContext,
): StoredContextView[] {
  return drafts.map((draft, index) => {
    const view = normalizeViewDraft(draft, context, index);
    const stored = store.upsertView(view);
    store.appendRuntimeEvent({
      event_type: "processor.view_written",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: stored.id,
      plugin_id: context.processor.id,
      related_records: stored.source_records,
      related_views: stored.source_views,
      payload: {
        processor_id: context.processor.id,
        view_type: stored.view_type,
        runtime: context.processor.runtime.kind,
      },
    });
    return stored;
  });
}

function normalizeViewDraft(
  draft: ViewDraft,
  context: WriteViewDraftContext,
  index: number,
): ContextView {
  const sourceRecords = unique([...(context.source_record_ids ?? []), ...(draft.source_records ?? [])]);
  const sourceViews = unique([...(context.source_view_ids ?? []), ...(draft.source_views ?? [])]);
  const compilerMode = compilerModeFor(context.processor);
  const id = draft.id ?? draftId(context.processor, draft, sourceRecords, sourceViews, index);
  const scope = draft.scope ?? inheritedScope(context.processor, draft);
  const privacy = draft.privacy ?? inheritedPrivacy(context.processor, draft);
  const storage = VIEW_STORAGE_BY_TYPE.get(draft.type) ?? { kind: "inline_json" };
  const content = normalizeContentForStorage(draft, storage);

  return {
    ...draft,
    id,
    view_type: draft.type,
    source_records: sourceRecords,
    source_views: sourceViews,
    compiler: {
      id: context.processor.id,
      version: context.processor.version,
      mode: compilerMode,
      ...draft.compiler,
    },
    scope,
    content,
    privacy,
    metadata: {
      ...(draft.metadata ?? {}),
      view_storage: storage,
      processor_runtime: context.processor.runtime.kind,
    },
  };
}

function normalizeContentForStorage(draft: ViewDraft, storage: ViewStorageSpec): Record<string, unknown> {
  const content = { ...(draft.content ?? {}) };
  if (storage.kind !== "markdown") return content;

  const markdownKey = storage.content_key ?? "markdown";
  if (typeof content[markdownKey] !== "string" || !String(content[markdownKey]).trim()) {
    content[markdownKey] = fallbackMarkdown(draft, content);
  }
  if (storage.path_template && typeof content.markdown_path !== "string") {
    content.markdown_path = renderStoragePath(storage.path_template, draft, content);
  }
  return content;
}

function fallbackMarkdown(draft: ViewDraft, content: Record<string, unknown>): string {
  const title = draft.title ?? draft.type;
  const summary = draft.summary ?? stringValue(content.summary);
  const lines = [`# ${title}`, ""];
  if (summary) lines.push(summary, "");
  const interestingEntries = Object.entries(content)
    .filter(([key, value]) => !["markdown", "markdown_path", "generated_at"].includes(key) && value !== undefined && value !== null)
    .slice(0, 12);
  if (interestingEntries.length) {
    lines.push("## Content", "");
    for (const [key, value] of interestingEntries) {
      lines.push(`- ${key}: ${inlineValue(value)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderStoragePath(template: string, draft: ViewDraft, content: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key: string) => {
    const value = storagePathVariable(key, draft, content);
    return sanitizePathSegment(value ?? key);
  });
}

function storagePathVariable(key: string, draft: ViewDraft, content: Record<string, unknown>): string | undefined {
  const direct = stringValue(content[key]);
  if (direct) return direct;
  if (key === "subject") return stringValue(content.subject) ?? draft.scope?.user ?? draft.scope?.project ?? "user";
  if (key === "date") {
    const date = stringValue(content.date);
    if (date) return date;
    const start = draft.scope?.time_range?.start;
    if (start) return start.slice(0, 10);
  }
  return undefined;
}

function sanitizePathSegment(value: string): string {
  return value.trim().replace(/[/\\]/g, "-").replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 120) || "unknown";
}

function inlineValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(item => inlineValue(item)).join(", ").slice(0, 240);
  if (typeof value === "object" && value) return JSON.stringify(value).slice(0, 240);
  return String(value).replace(/\s+/g, " ").trim().slice(0, 240);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function draftId(
  processor: ProcessorDefinition,
  draft: ViewDraft,
  sourceRecords: string[],
  sourceViews: string[],
  index: number,
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({
      processor_id: processor.id,
      version: processor.version,
      type: draft.type,
      title: draft.title,
      summary: draft.summary,
      source_records: sourceRecords,
      source_views: sourceViews,
      content: draft.content ?? {},
      index,
    }))
    .digest("hex")
    .slice(0, 16);
  return `${draft.type}:${processor.id}:${hash}`;
}

function compilerModeFor(processor: ProcessorDefinition): NonNullable<ContextView["compiler"]>["mode"] {
  if (processor.runtime.kind === "llm" || processor.runtime.kind === "agent_task") return "llm";
  if (processor.runtime.kind === "local") return "deterministic";
  return "hybrid";
}

function inheritedScope(processor: ProcessorDefinition, draft: ViewDraft): ContextView["scope"] {
  if (!draft.scope && processor.policy?.privacy) return undefined;
  return draft.scope;
}

function inheritedPrivacy(processor: ProcessorDefinition, draft: ViewDraft): ContextRecord["privacy"] {
  if (draft.privacy) return draft.privacy;
  const privacy = processor.policy?.privacy;
  if (!privacy || privacy === "inherit") return undefined;
  return { level: privacy };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
