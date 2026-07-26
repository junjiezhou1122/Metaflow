import { z } from "zod";
import type { BrowserAttention, BrowserCaptureEvent } from "@info/browser-capture-adapter/wire";

const TimestampSchema = z.string().datetime({ offset: true });

export const PersistedBrowserTabStateSchema = z.object({
  tabId: z.number().int().nonnegative(),
  windowId: z.number().int().nonnegative(),
  url: z.string().url(),
  domain: z.string().trim().min(1),
  visitId: z.string().trim().min(1).max(240),
  openedAt: TimestampSchema,
  startedAt: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative(),
  visitRecorded: z.boolean(),
  initialSnapshotRecorded: z.boolean().default(false),
  snapshotCount: z.number().int().nonnegative(),
  lastSnapshotAt: z.number().int().nonnegative(),
  documentId: z.string().trim().min(1).max(240).optional(),
  frameId: z.number().int().nonnegative().optional(),
  title: z.string().max(500).optional(),
  privacy: z.record(z.unknown()).optional(),
}).strict();

export type PersistedBrowserTabState = z.infer<typeof PersistedBrowserTabStateSchema>;

export function parsePersistedBrowserTabStates(input: unknown): PersistedBrowserTabState[] {
  return z.array(PersistedBrowserTabStateSchema).max(10_000).parse(input ?? []);
}

export function resolveBrowserVisitState(input: {
  existing?: PersistedBrowserTabState;
  tab_id: number;
  window_id: number;
  url: string;
  document_id?: string;
  frame_id?: number;
  mark_activated?: boolean;
  now_ms: number;
  now_iso: string;
  id_factory: () => string;
}): { state: PersistedBrowserTabState; created: boolean } {
  const url = new URL(input.url).toString();
  const sameDocument = !input.existing?.documentId
    || !input.document_id
    || input.existing.documentId === input.document_id;
  if (input.existing?.url === url && sameDocument) {
    const state = PersistedBrowserTabStateSchema.parse({
      ...input.existing,
      windowId: input.window_id,
      ...(input.document_id ? { documentId: input.document_id } : {}),
      ...(input.frame_id !== undefined ? { frameId: input.frame_id } : {}),
      ...(input.mark_activated ? { activatedAt: input.now_ms } : {}),
    });
    return { state, created: false };
  }

  const parsed = new URL(url);
  return {
    created: true,
    state: PersistedBrowserTabStateSchema.parse({
      tabId: input.tab_id,
      windowId: input.window_id,
      url,
      domain: parsed.hostname,
      visitId: input.id_factory(),
      openedAt: input.now_iso,
      startedAt: input.now_ms,
      activatedAt: input.now_ms,
      visitRecorded: false,
      initialSnapshotRecorded: false,
      snapshotCount: 0,
      lastSnapshotAt: 0,
      ...(input.document_id ? { documentId: input.document_id } : {}),
      ...(input.frame_id !== undefined ? { frameId: input.frame_id } : {}),
    }),
  };
}

export function classifyBrowserAttention(input: {
  tab_active: boolean;
  window_focused: boolean;
  window_state?: string;
}): BrowserAttention {
  if (input.tab_active && input.window_focused && input.window_state !== "minimized") return "focused";
  if (input.tab_active) return "background";
  return "open";
}

export function browserNavigationIdentity(input: {
  visit_id: string;
  action: "navigation_committed" | "navigation_history_state";
  document_id: string;
  frame_id: number;
  timestamp_ms: number;
}): { event_id: string; navigation_id: string } {
  const occurrence = `${input.document_id}:${input.frame_id}:${Math.trunc(input.timestamp_ms)}`;
  return {
    event_id: `browser:${input.action}:${occurrence}`.slice(0, 240),
    navigation_id: `${input.visit_id}:${input.action}:${occurrence}`.slice(0, 240),
  };
}

export function browserPolicyForUrl(
  rawUrl: string,
  settings: { excluded_domains: string[]; allow_external_model: boolean },
): BrowserCaptureEvent["policy"] {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return sensitiveDoNotStorePolicy();
  }
  const host = url.hostname;
  const sensitive = !["http:", "https:"].includes(url.protocol)
    || settings.excluded_domains.some(domain => host === domain || host.endsWith(`.${domain}`))
    || /(bank|pay|checkout|1password|bitwarden|lastpass|account|login|password|token|secret|oauth|auth|mail|gmail|icloud)/i.test(host + url.pathname);
  if (sensitive) return sensitiveDoNotStorePolicy();
  const publicWeb = !/(localhost|127\.0\.0\.1|\.local$)/i.test(host);
  return {
    owner: "user:local",
    visibility: "private",
    privacy: "private",
    retention: "normal",
    allow_external_model: publicWeb && settings.allow_external_model,
    allow_embedding: true,
    allow_local_search: true,
    labels: [],
  };
}

function sensitiveDoNotStorePolicy(): BrowserCaptureEvent["policy"] {
  return {
    owner: "user:local",
    visibility: "private",
    privacy: "sensitive",
    retention: "do_not_store",
    allow_external_model: false,
    allow_embedding: false,
    allow_local_search: false,
    labels: [],
  };
}
