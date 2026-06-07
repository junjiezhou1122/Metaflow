import type { ContextRecord, RuntimeEvent, StoredContextRecord, StoredRuntimeEvent } from "@info/core";

export type TriggerType = "event" | "schedule" | "manual" | "state";

export type PrivacyLevel = "public" | "workspace" | "private" | "secret";

export type TriggerMatch = {
  event_type?: string | string[];
  schema?: string | string[];
  source_type?: string | string[];
  connector?: string | string[];
  url_regex?: string;
  path_regex?: string;
  domain?: string | string[];
  privacy_level?: PrivacyLevel | PrivacyLevel[];
};

export type TriggerAction = {
  kind: "run_plugin" | "run_sensor" | "compile_view" | "build_pack";
  id: string;
  mode?: "sync" | "void" | "enqueue";
  queue?: string;
  payload?: Record<string, unknown>;
};

export type ContextTrigger = {
  id: string;
  type: TriggerType;
  description?: string;
  on?: string;
  match?: TriggerMatch;
  action: TriggerAction;
  priority?: number;
  enabled?: boolean;
};

export type TriggerSubject = {
  record?: StoredContextRecord | ContextRecord;
};

export type TriggerDecision = {
  trigger: ContextTrigger;
  action: TriggerAction;
  reason: string;
};

export type TriggerEvaluation = {
  event: RuntimeEvent | StoredRuntimeEvent;
  subject?: TriggerSubject;
  decisions: TriggerDecision[];
  skipped: Array<{ trigger_id: string; reason: string }>;
};

export const BUILTIN_CONTEXT_TRIGGERS: ContextTrigger[] = [
  {
    id: "builtin.work-thread-on-context-record",
    type: "event",
    on: "record_ingested",
    description: "Compile active coding WorkThread view when useful raw context arrives.",
    match: {
      schema: [
        "observation.browser_page_snapshot",
        "observation.browser_text_selected",
        "observation.local_project",
        "observation.ai_session_locator_result",
        "observation.screenpipe_activity_summary",
        "observation.screenpipe_workspace_signal",
        "observation.screenpipe_input_event",
      ],
    },
    action: { kind: "compile_view", id: "builtin.work-thread-view", mode: "enqueue" },
    priority: 100,
  },
  {
    id: "builtin.work-thread-scheduled",
    type: "schedule",
    on: "schedule_tick",
    description: "Periodic fallback compiler for the active coding WorkThread view.",
    action: { kind: "compile_view", id: "builtin.work-thread-view", mode: "sync" },
    priority: 60,
  },
];

export function evaluateTriggers(
  event: RuntimeEvent | StoredRuntimeEvent,
  triggers: ContextTrigger[],
  subject: TriggerSubject = {},
): TriggerEvaluation {
  const decisions: TriggerDecision[] = [];
  const skipped: TriggerEvaluation["skipped"] = [];

  for (const trigger of triggers) {
    const result = matchTrigger(event, trigger, subject);
    if (result.ok) {
      decisions.push({ trigger, action: trigger.action, reason: result.reason });
    } else {
      skipped.push({ trigger_id: trigger.id, reason: result.reason });
    }
  }

  decisions.sort((a, b) => (b.trigger.priority ?? 0) - (a.trigger.priority ?? 0));
  return { event, subject, decisions, skipped };
}

export function matchTrigger(
  event: RuntimeEvent | StoredRuntimeEvent,
  trigger: ContextTrigger,
  subject: TriggerSubject = {},
): { ok: true; reason: string } | { ok: false; reason: string } {
  if (trigger.enabled === false) return { ok: false, reason: "disabled" };
  if (trigger.on && trigger.on !== event.event_type) return { ok: false, reason: `event_type mismatch: ${event.event_type}` };
  if (trigger.match?.event_type && !oneOf(event.event_type, trigger.match.event_type)) return { ok: false, reason: `event_type not matched: ${event.event_type}` };

  const record = subject.record;
  const match = trigger.match;
  if (!match) return { ok: true, reason: "no match constraints" };

  if (match.schema && !record) return { ok: false, reason: "schema match requires record subject" };
  if (record && match.schema && !oneOf(record.schema.name, match.schema)) return { ok: false, reason: `schema not matched: ${record.schema.name}` };
  if (record && match.source_type && !oneOf(record.source.type, match.source_type)) return { ok: false, reason: `source_type not matched: ${record.source.type}` };
  if (record && match.connector && !oneOf(record.source.connector, match.connector)) return { ok: false, reason: `connector not matched: ${record.source.connector ?? ""}` };
  if (record && match.domain && !oneOf(record.scope?.domain ?? domainFromUrl(record.content?.url), match.domain)) return { ok: false, reason: `domain not matched: ${record.scope?.domain ?? ""}` };
  if (record && match.privacy_level && !oneOf(record.privacy?.level, match.privacy_level)) return { ok: false, reason: `privacy_level not matched: ${record.privacy?.level ?? ""}` };
  if (record && match.url_regex && !regexTest(match.url_regex, record.content?.url ?? "")) return { ok: false, reason: "url_regex not matched" };
  if (record && match.path_regex && !regexTest(match.path_regex, record.content?.path ?? "")) return { ok: false, reason: "path_regex not matched" };

  return { ok: true, reason: "matched" };
}

export function decisionsToRuntimeEvents(input: TriggerEvaluation): RuntimeEvent[] {
  return input.decisions.map(decision => ({
    event_type: "trigger_matched",
    actor: "system",
    status: "completed",
    subject_type: input.event.subject_type,
    subject_id: input.event.subject_id,
    plugin_id: decision.action.id,
    related_records: input.subject?.record?.id ? [input.subject.record.id] : input.event.related_records,
    payload: {
      trigger_id: decision.trigger.id,
      trigger_type: decision.trigger.type,
      action: decision.action,
      reason: decision.reason,
      source_event_type: input.event.event_type,
      source_event_id: "id" in input.event ? input.event.id : undefined,
    },
  }));
}

function oneOf(value: string | undefined, expected: string | string[] | undefined): boolean {
  if (!expected) return true;
  if (!value) return false;
  return Array.isArray(expected) ? expected.includes(value) : expected === value;
}

function regexTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}

function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
