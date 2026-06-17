import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  CircleCheck,
  RotateCcw,
  ExternalLink,
  Globe,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  Separator,
} from "@chrome-acp/shared/components";
import "@chrome-acp/shared/components";

type AmbientView = {
  id: string;
  view_type: string;
  title?: string;
  content?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  source_records?: string[];
  compiler?: { id?: string; program_id?: string };
  confidence?: number;
  status?: string;
  updated_at?: string;
  summary?: string;
};

type ListResponse = {
  ok: boolean;
  views?: AmbientView[];
  next_cursor?: string;
  error?: string;
};

type TriggerResponse = {
  ok: boolean;
  error?: string;
  body?: { processing?: { runs?: Array<{ written_views?: string[] }> }; written_views?: string[] };
};

type AgentTasksActionResponse = {
  ok: boolean;
  error?: string;
  queued?: number;
  processed?: number;
  skipped?: number;
  task_list?: { counts?: Record<string, number> };
};

type AgentTaskItemActionResponse = {
  ok: boolean;
  error?: string;
  action?: "cancel" | "retry";
  task_id?: string;
};

const PREFIX_LABEL: Record<string, string> = {
  "analysis.browser_page": "Page analysis",
  "analysis.browser_agent_task": "Agent analysis",
  "analysis.repo": "Repo analysis",
  "advice.research": "Research advice",
  "advice.writing_assist": "Writing assist",
  "agent.task_list": "Task list",
  "task.background_research": "Background research",
  "task.toolsmith_prototype": "Toolsmith task",
  "opportunity.tool": "Tool opportunity",
  "brief.background_research": "Research brief",
};

function shortType(viewType: string): string {
  return PREFIX_LABEL[viewType] ?? viewType.split(".").slice(-1)[0];
}

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function confidenceLabel(c?: number): { label: string; tone: "high" | "mid" | "low" } {
  if (typeof c !== "number") return { label: "", tone: "mid" };
  if (c >= 0.8) return { label: `${Math.round(c * 100)}%`, tone: "high" };
  if (c >= 0.5) return { label: `${Math.round(c * 100)}%`, tone: "mid" };
  return { label: `${Math.round(c * 100)}%`, tone: "low" };
}

function taskStatusTone(status?: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "cancelled") return "outline";
  return "secondary";
}

function canRunTaskLifecycleAction(view: AmbientView): boolean {
  return view.view_type.startsWith("task.");
}

function summaryOf(view: AmbientView): string {
  if (view.summary) return view.summary;
  const c: any = view.content ?? {};
  if (typeof c.summary === "string") return c.summary;
  if (typeof c.analysis === "string") return c.analysis;
  if (typeof c.text === "string") return c.text.slice(0, 280);
  if (typeof c.advice === "string") return c.advice;
  if (Array.isArray(c.key_points) && c.key_points.length) {
    return c.key_points.slice(0, 3).join(" • ");
  }
  if (typeof c.goal === "string") return c.goal;
  return "";
}

function keyPointsOf(view: AmbientView): string[] {
  const c: any = view.content ?? {};
  const points = c.key_points ?? c.keyPoints ?? c.takeaways ?? c.next_actions;
  if (!Array.isArray(points)) return [];
  return points
    .map((point: unknown) => typeof point === "string" ? point : JSON.stringify(point))
    .filter(Boolean)
    .slice(0, 8);
}

function detailRowsOf(view: AmbientView): Array<[string, string]> {
  const c: any = view.content ?? {};
  const rows: Array<[string, string]> = [];
  for (const key of ["analysis", "advice", "rationale", "goal", "status", "source", "recommendation"]) {
    const value = c[key];
    if (typeof value === "string" && value.trim()) rows.push([key.replace(/_/g, " "), value.trim()]);
  }
  return rows.slice(0, 5);
}

// Resolve the local info web UI origin. The default is the Vite dev server
// (apps/ui); operators that run the UI elsewhere can override the URL via
// chrome.storage.local["infoWebOrigin"]. We read it lazily so a settings
// change applies on the next click.
async function resolveInfoWebOrigin(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get("infoWebOrigin");
    const value = stored?.infoWebOrigin;
    if (typeof value === "string" && value.startsWith("http")) return value.replace(/\/$/, "");
  } catch {
    // storage may be unavailable in some contexts; fall through to default.
  }
  return "http://localhost:5173";
}

async function openInInfoWeb(viewId: string): Promise<void> {
  const origin = await resolveInfoWebOrigin();
  window.open(`${origin}/views/${encodeURIComponent(viewId)}`, "_blank", "noopener,noreferrer");
}

function sourceUrlOf(view: AmbientView): string | undefined {
  const c: any = view.content ?? {};
  const s: any = view.scope ?? {};
  if (typeof c.url === "string") return c.url;
  if (typeof c.source_url === "string") return c.source_url;
  if (typeof s.domain === "string") return `https://${s.domain}`;
  return undefined;
}

export function TasksView() {
  const [views, setViews] = useState<AmbientView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set(["agent.", "task."]));
  const filter = "all"; // kept for legacy callers; UI now uses activeFilters directly
  const toggleFilter = useCallback((prefix: string) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      // never let the user disable everything; fall back to "all" (no prefix).
      if (next.size === 0) return new Set<string>();
      return next;
    });
  }, []);
  const [triggering, setTriggering] = useState(false);
  const [lastTriggerError, setLastTriggerError] = useState<string | null>(null);
  const [taskAction, setTaskAction] = useState<"queue" | "process" | "cancel" | "retry" | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [lastTaskMessage, setLastTaskMessage] = useState<string | null>(null);
  const [lastTaskError, setLastTaskError] = useState<string | null>(null);
  const refreshTimer = useRef<number | null>(null);

  const filteredPrefixes = useMemo(() => {
    // activeFilters empty means "no prefix" → all view types.
    return Array.from(activeFilters);
  }, [activeFilters]);

  const load = useCallback(
    async (mode: "replace" | "append" = "replace") => {
      if (mode === "replace") setLoading(true);
      setError(null);
      try {
        // Use the first non-empty filter prefix to drive the server query;
        // remaining filters are applied client-side. This keeps server
        // roundtrips at one per refresh and lets the user combine filters
        // without exploding the request fan-out.
        const primaryPrefix = filteredPrefixes[0] ?? undefined;
        const response = (await chrome.runtime.sendMessage({
          type: "list-ambient-tasks",
          viewTypePrefix: primaryPrefix,
          cursor: mode === "append" ? cursor : undefined,
          limit: 60,
          activeOnly: false,
        })) as ListResponse;
        if (!response?.ok) {
          setError(response?.error ?? "Failed to load ambient tasks");
          if (mode === "replace") setViews([]);
          return;
        }
        let incoming = response.views ?? [];
        if (filteredPrefixes.length > 1) {
          // Combine selected namespaces with OR semantics. These are View
          // families, not workflow steps, so selecting Queue + Tasks should show
          // both agent.task_list and task.* Views.
          incoming = incoming.filter(v => filteredPrefixes.some(p => v.view_type.startsWith(p)));
        }
        setViews(prev => (mode === "append" ? [...prev, ...incoming] : incoming));
        setCursor(response.next_cursor);
        setHasMore(Boolean(response.next_cursor) && incoming.length > 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [cursor, filteredPrefixes],
  );

  useEffect(() => {
    setCursor(undefined);
    void load("replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters]);

  useEffect(() => {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    refreshTimer.current = window.setInterval(() => {
      void load("replace");
    }, 8000);
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilters]);

  const triggerAmbient = useCallback(async () => {
    setTriggering(true);
    setLastTriggerError(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "trigger-ambient",
        reason: "Side panel ambient analysis request",
      })) as TriggerResponse;
      if (!response?.ok) {
        setLastTriggerError(response?.error ?? "Ambient request failed");
      } else {
        window.setTimeout(() => void load("replace"), 1500);
      }
    } catch (e) {
      setLastTriggerError(e instanceof Error ? e.message : String(e));
    } finally {
      setTriggering(false);
    }
  }, [load]);

  const runTaskAction = useCallback(async (mode: "queue" | "process") => {
    setTaskAction(mode);
    setLastTaskError(null);
    setLastTaskMessage(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "agent-tasks",
        mode,
        runtime: mode === "process" ? "local_mock" : undefined,
        limit: mode === "process" ? 1 : 8,
      })) as AgentTasksActionResponse;
      if (!response?.ok) {
        setLastTaskError(response?.error ?? `Agent task ${mode} failed`);
        return;
      }
      const counts = response.task_list?.counts ?? {};
      setLastTaskMessage(
        mode === "queue"
          ? `Queued ${response.queued ?? 0}; open ${Number(counts.queued ?? 0) + Number(counts.candidate ?? 0)}.`
          : `Processed ${response.processed ?? 0}; skipped ${response.skipped ?? 0}.`,
      );
      await load("replace");
    } catch (e) {
      setLastTaskError(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskAction(null);
    }
  }, [load]);

  const runTaskItemAction = useCallback(async (view: AmbientView, action: "cancel" | "retry") => {
    setTaskAction(action);
    setActiveTaskId(view.id);
    setLastTaskError(null);
    setLastTaskMessage(null);
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "agent-task-action",
        taskId: view.id,
        action,
        reason: action === "cancel" ? "Cancelled from Chrome ACP Tasks view." : "Retried from Chrome ACP Tasks view.",
      })) as AgentTaskItemActionResponse;
      if (!response?.ok) {
        setLastTaskError(response?.error ?? `Task ${action} failed`);
        return;
      }
      setLastTaskMessage(action === "cancel" ? "Task cancelled." : "Task requeued.");
      await load("replace");
    } catch (e) {
      setLastTaskError(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskAction(null);
      setActiveTaskId(null);
    }
  }, [load]);

  return (
    <div className="flex flex-col h-full">
      <header className="px-3 pt-3 pb-2 flex items-center justify-between gap-2 border-b">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">Agent Work Queue</h2>
          <Badge variant="secondary" className="text-[10px]">
            {views.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void load("replace")}
            disabled={loading}
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
          <Button
            size="sm"
            onClick={() => void triggerAmbient()}
            disabled={triggering}
            title="Analyze current page now"
          >
            {triggering ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            <span className="ml-1.5">Analyze</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runTaskAction("queue")}
            disabled={Boolean(taskAction)}
            title="Queue background agent tasks"
          >
            {taskAction === "queue" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Queue</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runTaskAction("process")}
            disabled={Boolean(taskAction)}
            title="Run one queued task with the local mock runtime"
          >
            {taskAction === "process" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CircleCheck className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Run</span>
          </Button>
        </div>
      </header>

      <div className="px-3 py-2 flex items-center gap-1 text-xs border-b bg-muted/30 flex-wrap">
          {[
          { id: "agent.", label: "Queue view" },
          { id: "task.", label: "Task views" },
          { id: "brief.", label: "Results" },
          { id: "advice.", label: "Suggestions" },
          { id: "opportunity.", label: "Opportunities" },
          { id: "analysis.", label: "Browser analysis" },
        ].map(f => {
          const active = activeFilters.has(f.id);
          return (
            <Button
              key={f.id}
              size="sm"
              variant={active ? "default" : "ghost"}
              className="h-6 px-2 text-xs"
              onClick={() => toggleFilter(f.id)}
              title={active ? `Hide ${f.label}` : `Show ${f.label}`}
            >
              {f.label}
            </Button>
          );
        })}
        {activeFilters.size > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs ml-auto"
            onClick={() => setActiveFilters(new Set())}
          >
            All
          </Button>
        )}
      </div>

      {lastTriggerError && (
        <div className="px-3 py-2 text-xs text-destructive flex items-center gap-1.5 border-b">
          <CircleAlert className="h-3.5 w-3.5" />
          {lastTriggerError}
        </div>
      )}
      {lastTaskError && (
        <div className="px-3 py-2 text-xs text-destructive flex items-center gap-1.5 border-b">
          <CircleAlert className="h-3.5 w-3.5" />
          {lastTaskError}
        </div>
      )}
      {lastTaskMessage && (
        <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5 border-b">
          <CircleCheck className="h-3.5 w-3.5 text-green-500" />
          {lastTaskMessage}
        </div>
      )}

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {error && (
            <Card className="border-destructive/40">
              <CardContent className="p-3 text-xs text-destructive">{error}</CardContent>
            </Card>
          )}

          {!loading && !error && views.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-12">
              <Sparkles className="h-5 w-5 mx-auto mb-2 opacity-50" />
              <p>No agent work items yet.</p>
              <p className="mt-1">Click &quot;Analyze&quot; to create suggestions, or &quot;Queue&quot; to collect slow agent tasks.</p>
            </div>
          )}

          {views.map(view => {
            const conf = confidenceLabel(view.confidence);
            const summary = summaryOf(view);
            const url = sourceUrlOf(view);
            return (
              <Collapsible key={view.id}>
                <Card className="hover:bg-accent/30 transition-colors">
                  <CardContent className="p-3">
                    <CollapsibleTrigger className="w-full text-left">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {shortType(view.view_type)}
                            </Badge>
                            {view.status === "accepted" && (
                              <CircleCheck className="h-3 w-3 text-green-500 shrink-0" />
                            )}
                            {view.status === "cancelled" && (
                              <RotateCcw className="h-3 w-3 text-muted-foreground shrink-0" />
                            )}
                            {view.status && view.status !== "accepted" && view.status !== "cancelled" && (
                              <Badge variant={taskStatusTone(view.status)} className="text-[10px] shrink-0">
                                {view.status}
                              </Badge>
                            )}
                            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
                              {timeAgo(view.updated_at)}
                            </span>
                          </div>
                          <div className="mt-1.5 text-sm font-medium leading-snug line-clamp-2">
                            {view.title ?? summary ?? "(untitled)"}
                          </div>
                          {summary && view.title && (
                            <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
                              {summary}
                            </div>
                          )}
                          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                            {url && (
                              <span className="flex items-center gap-1 truncate">
                                <ExternalLink className="h-3 w-3 shrink-0" />
                                <span className="truncate">{url}</span>
                              </span>
                            )}
                            {conf.label && <span>· {conf.label} conf</span>}
                          </div>
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <Separator className="my-2" />
                      <div className="space-y-3">
                        {summary && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Summary</div>
                            <p className="text-xs leading-relaxed text-foreground/85">{summary}</p>
                          </div>
                        )}
                        {keyPointsOf(view).length > 0 && (
                          <div>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Key points</div>
                            <ul className="space-y-1">
                              {keyPointsOf(view).map((point, index) => (
                                <li key={index} className="flex gap-2 text-xs leading-relaxed text-foreground/85">
                                  <span className="mt-1.5 h-1 w-1 rounded-full bg-muted-foreground/70 shrink-0" />
                                  <span>{point}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {detailRowsOf(view).map(([label, value]) => (
                          <div key={label}>
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
                            <p className="text-xs leading-relaxed text-foreground/85">{value}</p>
                          </div>
                        ))}
                        <details className="rounded border bg-muted/20 px-2 py-1.5">
                          <summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">Raw view</summary>
                          <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[10px] leading-relaxed text-muted-foreground">
                            {JSON.stringify(view.content ?? {}, null, 2)}
                          </pre>
                        </details>
                      </div>
                      <div className="mt-2 flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void openInInfoWeb(view.id)}
                          title="Open in info web UI"
                        >
                          <Globe className="h-3 w-3 mr-1" />
                          Info
                        </Button>
                        {url && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
                          >
                            <ExternalLink className="h-3 w-3 mr-1" />
                            Open
                          </Button>
                        )}
                        {canRunTaskLifecycleAction(view) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={taskAction !== null}
                            onClick={() => void runTaskItemAction(view, view.status === "cancelled" ? "retry" : "cancel")}
                            title={view.status === "cancelled" ? "Retry task" : "Cancel task"}
                          >
                            {taskAction === (view.status === "cancelled" ? "retry" : "cancel") && activeTaskId === view.id ? (
                              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                            ) : (
                              <RotateCcw className="h-3 w-3 mr-1" />
                            )}
                            {view.status === "cancelled" ? "Retry" : "Cancel"}
                          </Button>
                        )}
                      </div>
                    </CollapsibleContent>
                  </CardContent>
                </Card>
              </Collapsible>
            );
          })}

          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button size="sm" variant="ghost" onClick={() => void load("append")} disabled={loading}>
                Load more
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

export default TasksView;
