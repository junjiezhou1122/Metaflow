export const DEFAULT_CONTEXT_INGEST_ENDPOINT = "http://localhost:3111/context/ingest";
export const DEFAULT_RELATED_VIEW_TYPES = [
  "analysis.browser_agent_task",
  "project.current_context",
  "thread.active_work",
  "brief.project_next_state",
  "brief.research",
  "advice.writing_assist",
  "draft.writing_continuation",
  "memory.project.patterns",
];

export const DEFAULT_VIEW_FILTERS = {
  related: DEFAULT_RELATED_VIEW_TYPES,
  agent: ["analysis.browser_agent_task"],
  writing: ["advice.writing_assist", "draft.writing_continuation"],
  all: undefined,
};

export function contextIngestEndpointFromSettings(settings, options = {}) {
  const url = new URL(settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT);
  if (options.process) url.searchParams.set("process", "true");
  if (options.cascadeViews) url.searchParams.set("cascade_views", "true");
  return url.toString();
}

export function contextViewUrlFromSettings(settings, viewId) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = `/context/views/${encodeURIComponent(viewId)}`;
  url.search = "";
  return url.toString();
}

export function writingAssistEndpointFromSettings(settings) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = "/writing/assist";
  url.search = "";
  return url.toString();
}


export function buildViewQueryFromTab(tab) {
  const parts = [tab?.title];
  try {
    const url = new URL(tab?.url || "");
    parts.push(url.hostname.replace(/^www\./, ""));
    parts.push(url.pathname);
  } catch {}
  return parts
    .filter(value => typeof value === "string" && value.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function contextViewsEndpointFromSettings(settings, options = {}) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = "/context/views";
  url.search = "";
  if (options.limit) url.searchParams.set("limit", String(options.limit));
  if (Array.isArray(options.viewTypes) && options.viewTypes.length) url.searchParams.set("view_types", options.viewTypes.join(","));
  if (options.viewTypePrefix) url.searchParams.set("view_type_prefix", options.viewTypePrefix);
  if (options.summaryOnly || options.viewTypePrefix) url.searchParams.set("summary_only", "true");
  if (options.activeOnly) url.searchParams.set("active_only", "true");
  if (options.cursor) url.searchParams.set("cursor", options.cursor);
  if (options.query) url.searchParams.set("query", options.query);
  if (options.sourceRecordId) url.searchParams.set("source_record_id", options.sourceRecordId);
  return url.toString();
}

export function feedbackEndpointFromSettings(settings, options = {}) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = "/feedback";
  url.search = "";
  if (options.process !== false) url.searchParams.set("process", "true");
  return url.toString();
}

export function agentTasksEndpointFromSettings(settings, options = {}) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = "/agent-tasks";
  url.search = "";
  if (options.cascadeViews) url.searchParams.set("cascade_views", "true");
  return url.toString();
}

export function contextChatEndpointFromSettings(settings) {
  const base = settings?.endpoint || DEFAULT_CONTEXT_INGEST_ENDPOINT;
  const url = new URL(base);
  url.pathname = "/context/chat";
  url.search = "";
  return url.toString();
}

export function buildBrowserAgentTaskRequest({ recordId, viewId, question, runtime = "claude_code", title, dryRun = false }) {
  const trimmed = String(question || "").trim();
  const source = recordId ? { record_id: recordId } : viewId ? { view_id: viewId } : {};
  return {
    ...source,
    dry_run: Boolean(dryRun),
    autonomy: "suggest",
    speed: "work",
    task: {
      runtime,
      goal: [
        trimmed || "Analyze the current browser page for the user.",
        "Answer only with a structured analysis View.",
        "Do not modify files. Do not return next_actions, tasks, tool plans, or diffs.",
        "Prefer concrete facts from the captured page and related Info Views.",
      ].join("\n"),
      constraints: {
        write_policy: "views_only",
        action_policy: "analysis_only",
        browser_surface: "chrome_extension_popup",
      },
      output_contract: {
        view_type: "analysis.browser_agent_task",
        title: title || "Browser Claude Code analysis",
        purpose: "Answer a user question about the current browser page using Info context.",
      },
    },
  };
}

export function buildViewFeedbackRequest({ viewId, viewType, type, value, reason, payload, applicationId = "browser.popup" }) {
  return {
    type,
    application_id: applicationId,
    view_id: viewId,
    value,
    reason,
    payload: {
      ...(payload ?? {}),
      ...(viewType ? { target_view_type: viewType } : {}),
    },
  };
}

export function viewIdsFromProcessedIngestResponse(body) {
  const direct = Array.isArray(body?.written_views) ? body.written_views : [];
  const firstPass = Array.isArray(body?.processing?.runs)
    ? body.processing.runs.flatMap(run => Array.isArray(run?.written_views) ? run.written_views : [])
    : [];
  const cascaded = Array.isArray(body?.cascade_processing)
    ? body.cascade_processing.flatMap(processing =>
        Array.isArray(processing?.runs)
          ? processing.runs.flatMap(run => Array.isArray(run?.written_views) ? run.written_views : [])
          : []
      )
    : [];
  return [...new Set([...direct, ...firstPass, ...cascaded].filter(id => typeof id === "string" && id))];
}

export function viewIdsFromAgentTaskResponse(body) {
  const direct = Array.isArray(body?.result?.written_views) ? body.result.written_views : [];
  const cascaded = Array.isArray(body?.cascade_processing)
    ? body.cascade_processing.flatMap(processing =>
        Array.isArray(processing?.runs)
          ? processing.runs.flatMap(run => Array.isArray(run?.written_views) ? run.written_views : [])
          : []
      )
    : [];
  return [...new Set([...direct, ...cascaded].filter(id => typeof id === "string" && id))];
}

export function viewSummaryText(view) {
  return view?.content?.agent_output?.summary
    || view?.content?.summary
    || view?.summary
    || view?.content?.text
    || "";
}

export function viewKeyPoints(view, limit = 3) {
  const points = Array.isArray(view?.content?.agent_output?.key_points)
    ? view.content.agent_output.key_points
    : Array.isArray(view?.content?.key_points)
      ? view.content.key_points
      : [];
  return points.filter(point => typeof point === "string" && point.trim()).slice(0, limit);
}

export function formatViewSubscriptionResult(result) {
  if (!result?.ok) return JSON.stringify(result, null, 2);
  const views = Array.isArray(result.views) ? result.views : [];
  const lines = views.slice(0, 8).map((view, index) => {
    const label = view.view_type || "view";
    const title = view.title || view.id;
    const viewSummary = viewSummaryText(view);
    const summary = viewSummary && viewSummary !== title ? ` — ${viewSummary}` : "";
    const id = view.id ? ` (${view.id})` : "";
    return `#${index + 1} ${label}: ${title}${summary}${id}`;
  });
  return [
    `${views.length} new View${views.length === 1 ? "" : "s"}`,
    lines.length ? lines.join("\n") : "No new Views.",
    result.next_cursor ? `\nCursor: ${result.next_cursor}` : undefined,
  ].filter(Boolean).join("\n\n");
}

export function selectedViewIdFromInput(input, views) {
  return selectedViewFromInput(input, views)?.id;
}

export function selectedViewFromInput(input, views) {
  const candidates = Array.isArray(views) ? views : [];
  const value = String(input ?? "").trim();
  if (!value) return candidates.find(view => view?.id);
  const indexMatch = value.match(/^#?(\d+)$/);
  if (indexMatch) return candidates[Number(indexMatch[1]) - 1];
  return candidates.find(view => view?.id === value);
}

export function feedbackTargetFromInput(input, views, fallbackViewId) {
  const value = String(input ?? "").trim();
  const selected = selectedViewFromInput(value, views);
  if (selected) return { ok: true, view: selected };
  if (value) return { ok: false, error: "Selected View not found." };
  const fallback = Array.isArray(views) ? views.find(view => view?.id === fallbackViewId) : undefined;
  return fallback ? { ok: true, view: fallback } : { ok: false, error: "No View selected for feedback." };
}

export function formatAmbientViewResult(result) {
  if (!result?.ok) return JSON.stringify(result, null, 2);
  const fetchedViews = Array.isArray(result.views) ? result.views.map(item => item?.view).filter(Boolean) : [];
  const view = fetchedViews[0];
  if (!view) return JSON.stringify(result, null, 2);

  const keyPoints = viewKeyPoints(view, 5);
  const cascaded = fetchedViews.slice(1, 6);
  return [
    view.title || view.view_type || "Ambient result",
    view.summary,
    keyPoints.length ? "\nKey points:\n" + keyPoints.map(point => `- ${point}`).join("\n") : undefined,
    cascaded.length ? "\nCascaded views:\n" + cascaded.map(item => `- ${item.view_type || "view"}: ${item.title || item.summary || item.id}`).join("\n") : undefined,
    `\nView: ${view.id}`,
  ].filter(Boolean).join("\n\n");
}
