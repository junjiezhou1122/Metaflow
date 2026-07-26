import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ContextStore } from "@info/core";
import type { ContextView, StoredContextView } from "@info/core";

const TOOLSMITH_SOURCE_TYPES = ["draft.tool_prototype", "opportunity.tool"] as const;

export type ToolsmithArtifactResult = {
  ok: true;
  generated_at: string;
  processed: number;
  skipped: number;
  artifacts: Array<{
    source_view_id: string;
    source_view_type: string;
    status: "completed" | "skipped";
    reason?: string;
    record_id?: string;
    artifact_id?: string;
    artifact_view_id?: string;
    uri?: string;
  }>;
};

export function processToolsmithSandboxArtifacts(options: { limit?: number; write?: boolean; output_dir?: string } = {}, store = new ContextStore()): ToolsmithArtifactResult {
  const generatedAt = new Date().toISOString();
  const candidates = store.listViews({ view_types: [...TOOLSMITH_SOURCE_TYPES], active_only: true, limit: options.limit ?? 8 })
    .filter(view => !toolArtifactAlreadyBuilt(view));
  const artifacts: ToolsmithArtifactResult["artifacts"] = [];

  for (const view of candidates) {
    const markdown = toolArtifactMarkdown(view, generatedAt);
    if (!markdown.trim()) {
      artifacts.push({ source_view_id: view.id, source_view_type: view.view_type, status: "skipped", reason: "empty tool prototype content" });
      continue;
    }

    const key = stableKey(`${view.id}:${markdown}`);
    const recordId = `record:toolsmith-artifact:${key}`;
    const artifactId = `artifact:toolsmith-sandbox:${key}`;
    const artifactViewId = `tool:prototype-artifact:${key}`;
    const outputDir = resolve(options.output_dir ?? process.env.TOOLSMITH_SANDBOX_DIR ?? "data/toolsmith-sandbox");
    const filePath = resolve(outputDir, `${safeSlug(view.title ?? view.view_type)}-${key}.md`);
    const uri = pathToFileURL(filePath).toString();
    const sha256 = createHash("sha256").update(markdown).digest("hex");

    artifacts.push({
      source_view_id: view.id,
      source_view_type: view.view_type,
      status: "completed",
      record_id: recordId,
      artifact_id: artifactId,
      artifact_view_id: artifactViewId,
      uri,
    });

    if (options.write === false) continue;

    mkdirSync(outputDir, { recursive: true });
    writeFileSync(filePath, markdown);
    const record = store.insertRecord({
      id: recordId,
      schema: { name: "observation.toolsmith_sandbox_artifact", version: 1 },
      source: { type: "runtime", connector: "runtime.toolsmith_artifacts" },
      scope: withPlugin(view.scope, "runtime.toolsmith_artifacts"),
      time: { observed_at: generatedAt, captured_at: generatedAt },
      content: {
        title: `Tool artifact: ${view.title ?? view.view_type}`.slice(0, 180),
        text: `Sandbox tool artifact generated from ${view.view_type}.`,
        path: filePath,
      },
      acquisition: { mode: "derived", actor: "system", reason: "compile toolsmith prototype into sandbox artifact" },
      signal: { importance: 0.72, confidence: Math.max(0.5, Math.min(0.9, view.confidence ?? 0.7)), status: "candidate" },
      privacy: view.privacy ?? { level: "private", retention: "normal", allow_external_llm: false },
      relations: { related_to: [view.id] },
      payload: {
        source_view_id: view.id,
        source_view_type: view.view_type,
        artifact_id: artifactId,
        artifact_view_id: artifactViewId,
        uri,
        sha256,
        sandbox_only: true,
        no_project_file_edits: true,
      },
    });
    if (!store.getArtifact(artifactId)) {
      store.insertArtifact({
        id: artifactId,
        record_id: record.id,
        kind: "file",
        mime_type: "text/markdown",
        uri,
        sha256,
        size_bytes: Buffer.byteLength(markdown),
        metadata: {
          source_view_id: view.id,
          source_view_type: view.view_type,
          sandbox_only: true,
          no_project_file_edits: true,
        },
      });
    }
    store.upsertView(buildArtifactView(view, record.id, artifactId, artifactViewId, uri, generatedAt));
    markSourceView(view, artifactViewId, artifactId, uri, generatedAt, store);
    store.appendRuntimeEvent({
      event_type: "toolsmith_artifact.created",
      actor: "system",
      status: "completed",
      subject_type: "view",
      subject_id: artifactViewId,
      plugin_id: "runtime.toolsmith_artifacts",
      related_records: [record.id],
      related_views: [view.id, artifactViewId],
      payload: { source_view_id: view.id, artifact_id: artifactId, uri, sandbox_only: true },
    });
  }

  return {
    ok: true,
    generated_at: generatedAt,
    processed: artifacts.filter(item => item.status === "completed").length,
    skipped: artifacts.filter(item => item.status === "skipped").length,
    artifacts,
  };
}

function toolArtifactMarkdown(view: StoredContextView, generatedAt: string): string {
  const focus = stringValue(view.content?.focus) ?? view.title ?? view.summary ?? view.id;
  const draft = stringValue(view.content?.draft_text)
    ?? stringValue(view.content?.prototype)
    ?? stringValue(view.content?.plan)
    ?? view.summary
    ?? "";
  const suggestions = arrayStrings(view.content?.suggestions);
  const evidence = arrayStrings(view.content?.evidence);
  return [
    `# ${view.title ?? "Tool Prototype"}`,
    "",
    `Generated: ${generatedAt}`,
    `Source View: ${view.id}`,
    `Source Type: ${view.view_type}`,
    "",
    "## Goal",
    "",
    focus,
    "",
    "## Prototype",
    "",
    draft || "No draft body was available; inspect the source View content.",
    suggestions.length ? "\n## Suggested Interface\n\n" + suggestions.map(item => `- ${item}`).join("\n") : "",
    evidence.length ? "\n## Evidence\n\n" + evidence.map(item => `- ${item}`).join("\n") : "",
    "",
    "## Boundary",
    "",
    "- Sandbox artifact only.",
    "- No project files were modified.",
    "- Implementation requires explicit user approval or sandbox_auto policy.",
    "",
    "## Raw View Content",
    "",
    "```json",
    JSON.stringify(view.content ?? {}, null, 2),
    "```",
    "",
  ].filter(Boolean).join("\n");
}

function buildArtifactView(source: StoredContextView, recordId: string, artifactId: string, artifactViewId: string, uri: string, generatedAt: string): ContextView {
  return {
    id: artifactViewId,
    view_type: "tool.prototype_artifact",
    title: `Sandbox tool artifact: ${source.title ?? source.view_type}`.slice(0, 180),
    summary: `Generated a sandbox artifact for ${source.title ?? source.view_type}.`,
    status: "candidate",
    source_records: [recordId],
    source_views: [source.id],
    compiler: { id: "runtime.toolsmith_artifacts", version: "0.1.0", mode: "deterministic" },
    purpose: "Inspectable sandbox artifact compiled from a toolsmith prototype without modifying project files.",
    scope: withPlugin(source.scope, "runtime.toolsmith_artifacts"),
    content: {
      source_view_id: source.id,
      source_view_type: source.view_type,
      artifact_id: artifactId,
      uri,
      generated_at: generatedAt,
      sandbox_only: true,
      no_project_file_edits: true,
    },
    confidence: Math.max(0.5, Math.min(0.88, source.confidence ?? 0.7)),
    stability: "project",
    lossiness: "low",
    privacy: source.privacy,
  };
}

function markSourceView(source: StoredContextView, artifactViewId: string, artifactId: string, uri: string, generatedAt: string, store: ContextStore): void {
  store.upsertView({
    ...source,
    content: {
      ...(source.content ?? {}),
      toolsmith_artifact: {
        status: "completed",
        generated_at: generatedAt,
        artifact_view_id: artifactViewId,
        artifact_id: artifactId,
        uri,
      },
    },
    metadata: {
      ...(source.metadata ?? {}),
      last_toolsmith_artifact_generated_at: generatedAt,
    },
  });
}

function toolArtifactAlreadyBuilt(view: StoredContextView): boolean {
  const state = view.content?.toolsmith_artifact;
  return Boolean(state && typeof state === "object" && !Array.isArray(state) && (state as Record<string, unknown>).status === "completed");
}

function withPlugin(scope: StoredContextView["scope"], plugin_id: string): StoredContextView["scope"] {
  return { ...(scope ?? {}), plugin_id };
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "tool-prototype";
}

function stableKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
