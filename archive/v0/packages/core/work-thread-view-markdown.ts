import { basename } from "node:path";
import type { ContextView, StoredContextView } from "./types.js";

export function workThreadViewToMarkdown(view: ContextView | StoredContextView): string {
  const content = view.content ?? {};
  const status = content.current_status as Record<string, unknown> | undefined;
  const nextActions = Array.isArray(content.next_actions) ? content.next_actions as string[] : [];
  const evidence = Array.isArray(content.evidence) ? content.evidence as Array<Record<string, unknown>> : [];
  return [
    `# ${view.title ?? "WorkThread"}`,
    "",
    view.summary ?? "",
    "",
    "## Current status",
    "",
    `- Confidence: ${view.confidence ?? status?.confidence ?? "unknown"}`,
    `- Project: ${status?.project ?? view.scope?.project ?? "unknown"}`,
    `- Latest: ${status?.latest_title ?? "unknown"}`,
    "",
    "## Next actions",
    "",
    ...nextActions.map(action => `- ${action}`),
    "",
    "## Evidence",
    "",
    ...evidence.slice(0, 12).map(item => `- ${item.observed_at ?? ""} ${item.schema ?? ""} ${item.title ?? basename(String(item.path ?? item.url ?? ""))}`.trim()),
  ].join("\n");
}
