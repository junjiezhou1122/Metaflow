import { z } from "zod";
import {
  OperatorExecutionFailure,
  inheritStrictestViewPolicy,
  type OperatorCandidateEnvelope,
  type OperatorExecutionEvent,
  type OperatorExecutionInvocation,
} from "@info/execution";
import {
  canonicalJson,
  exactViewRef,
  JsonValueSchema,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
} from "@info/view";

export const PERSONAL_TIMELINE_FUNCTION = { kind: "function", function_id: "personal.activity.timeline", version: 1 } as const;
export const PERSONAL_DAILY_SUMMARY_FUNCTION = { kind: "function", function_id: "personal.summary.daily", version: 1 } as const;

const PERSONAL_AUDIO_SCHEMA = { name: "personal.audio.semantic", version: 1 } as const;
const PERSONAL_TIMELINE_SCHEMA = { name: "personal.timeline.activity", version: 1 } as const;
const PERSONAL_DAILY_SUMMARY_SCHEMA = { name: "personal.summary.daily", version: 1 } as const;
const PERSONAL_AUDIO_REPRESENTATION = "personal_audio";
const PERSONAL_TIMELINE_REPRESENTATION = "personal_timeline";
const PERSONAL_DAILY_SUMMARY_REPRESENTATION = "personal_daily_summary";

const TimelineConfigurationSchema = z.object({
  timezone: z.string().trim().min(1).max(120).refine(isTimeZone, "timezone must be an IANA time zone"),
  output_view_prefix: z.string().trim().min(1).max(200),
}).strict();

const DailySummaryConfigurationSchema = z.object({
  output_view_prefix: z.string().trim().min(1).max(200),
}).strict();

type AudioValue = {
  started_at: string;
  ended_at: string;
  summary: string;
  topics: string[];
  decisions: string[];
  action_items: string[];
};

type TimelineEntry = {
  source_ref: ExactViewRef;
  occurred_at: string;
  kind: "audio";
  title: string;
  detail: string;
};

type TimelineBlock = {
  started_at: string;
  ended_at: string;
  title: string;
  summary: string;
  entries: TimelineEntry[];
};

type TimelineValue = {
  version: 1;
  date: string;
  timezone: string;
  started_at: string;
  ended_at: string;
  blocks: TimelineBlock[];
  signals: {
    top_topics: string[];
    decisions: string[];
    unfinished_threads: string[];
  };
};

type FunctionContext = {
  signal: AbortSignal;
  emit(event: OperatorExecutionEvent): Promise<void>;
};

export async function executePersonalTimeline(
  invocation: OperatorExecutionInvocation,
  context: FunctionContext,
): Promise<OperatorCandidateEnvelope> {
  assertFunction(invocation, PERSONAL_TIMELINE_FUNCTION, PERSONAL_TIMELINE_SCHEMA, "timeline");
  const configuration = parseConfiguration(TimelineConfigurationSchema, invocation, "timeline");
  const activityViews = roleViews(invocation, "activity_views", { min: 1 });
  const baseView = roleViews(invocation, "base_timeline", { min: 0, max: 1 })[0];
  assertNoUnexpectedRoles(invocation, new Set(["activity_views", "base_timeline"]), "timeline");
  assertUniqueExactViews(activityViews, "timeline_activity_duplicate");
  context.signal.throwIfAborted();

  const base = baseView ? readTimeline(baseView) : undefined;
  const priorRefs = new Set(base?.blocks.flatMap(block => block.entries.map(entry => refKey(entry.source_ref))) ?? []);
  const additions = activityViews
    .map(view => ({ view, value: readAudio(view) }))
    .filter(({ view }) => !priorRefs.has(refKey(exactViewRef(view))))
    .sort((left, right) => Date.parse(left.value.started_at) - Date.parse(right.value.started_at)
      || refKey(exactViewRef(left.view)).localeCompare(refKey(exactViewRef(right.view))));
  if (additions.length === 0) {
    throw new OperatorExecutionFailure(
      "timeline_no_new_activity",
      "Activity Timeline formation requires at least one exact Audio View not already present in the base Timeline",
      { supplied_count: activityViews.length, base_revision: baseView?.revision ?? 0 },
    );
  }

  const dates = new Set(additions.map(({ value }) => localDate(value.started_at, configuration.timezone)));
  if (base) dates.add(base.date);
  if (dates.size !== 1) {
    throw new OperatorExecutionFailure(
      "timeline_multiple_local_days",
      "One Activity Timeline Run may contain evidence from exactly one local day",
      { local_day_count: dates.size, timezone: configuration.timezone },
    );
  }
  const date = [...dates][0]!;
  if (base && base.timezone !== configuration.timezone) {
    throw new OperatorExecutionFailure(
      "timeline_timezone_mismatch",
      "The base Activity Timeline uses a different frozen timezone",
      { base_timezone: base.timezone, configured_timezone: configuration.timezone },
    );
  }

  const newBlocks: TimelineBlock[] = additions.map(({ view, value }) => ({
    started_at: value.started_at,
    ended_at: value.ended_at,
    title: value.topics[0] ?? view.name,
    summary: value.summary,
    entries: [{
      source_ref: exactViewRef(view),
      occurred_at: value.started_at,
      kind: "audio",
      title: view.name,
      detail: value.summary,
    }],
  }));
  const blocks = [...(base?.blocks ?? []), ...newBlocks]
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
  const signals = {
    top_topics: unique([...(base?.signals.top_topics ?? []), ...additions.flatMap(item => item.value.topics)]),
    decisions: unique([...(base?.signals.decisions ?? []), ...additions.flatMap(item => item.value.decisions)]),
    unfinished_threads: unique([...(base?.signals.unfinished_threads ?? []), ...additions.flatMap(item => item.value.action_items)]),
  };
  if (blocks.length > 288 || Object.values(signals).some(values => values.length > 100)) {
    throw new OperatorExecutionFailure(
      "timeline_content_limit_exceeded",
      "Activity Timeline formation cannot preserve all input evidence within the strict output Schema",
      {
        block_count: blocks.length,
        topic_count: signals.top_topics.length,
        decision_count: signals.decisions.length,
        unfinished_thread_count: signals.unfinished_threads.length,
      },
    );
  }
  const value: TimelineValue = {
    version: 1,
    date,
    timezone: configuration.timezone,
    started_at: blocks[0]!.started_at,
    ended_at: blocks.reduce((latest, block) => Date.parse(block.ended_at) > Date.parse(latest) ? block.ended_at : latest, blocks[0]!.ended_at),
    blocks,
    signals,
  };
  const inputs = invocation.inputs.flatMap(binding => binding.views);
  const viewId = baseView?.id ?? `${configuration.output_view_prefix}:${date}`;
  const candidate = candidateView(invocation, {
    id: viewId,
    name: `Activity Timeline · ${date}`,
    purpose: "Chronological activity blocks with exact source View evidence",
    representationKind: PERSONAL_TIMELINE_REPRESENTATION,
    value: value as unknown as JsonValue,
    inputs,
    base: baseView,
    metadata: { processor: "personal.activity.timeline@1", source_count: blocks.flatMap(block => block.entries).length },
  });

  await context.emit({
    type: "personal_activity.timeline.formed",
    payload: {
      date,
      added_count: additions.length,
      skipped_existing_count: activityViews.length - additions.length,
      total_source_count: blocks.flatMap(block => block.entries).length,
      base_revision: baseView?.revision ?? 0,
    },
  });
  context.signal.throwIfAborted();
  return { outputs: [candidate], diagnostics: { date, added_count: additions.length, block_count: blocks.length } };
}

export async function executePersonalDailySummary(
  invocation: OperatorExecutionInvocation,
  context: FunctionContext,
): Promise<OperatorCandidateEnvelope> {
  assertFunction(invocation, PERSONAL_DAILY_SUMMARY_FUNCTION, PERSONAL_DAILY_SUMMARY_SCHEMA, "daily summary");
  const configuration = parseConfiguration(DailySummaryConfigurationSchema, invocation, "daily summary");
  const timelineView = roleViews(invocation, "timeline", { min: 1, max: 1 })[0]!;
  const baseView = roleViews(invocation, "base_summary", { min: 0, max: 1 })[0];
  assertNoUnexpectedRoles(invocation, new Set(["timeline", "base_summary"]), "daily summary");
  context.signal.throwIfAborted();

  const timeline = readTimeline(timelineView);
  const base = baseView ? readDailySummary(baseView) : undefined;
  if (base && base.date !== timeline.date) {
    throw new OperatorExecutionFailure(
      "daily_summary_date_mismatch",
      "The base Daily Summary and input Activity Timeline must describe the same day",
      { base_date: base.date, timeline_date: timeline.date },
    );
  }
  if (base && refKey(base.source_timeline) === refKey(exactViewRef(timelineView))) {
    throw new OperatorExecutionFailure(
      "daily_summary_timeline_unchanged",
      "The base Daily Summary already freezes this exact Activity Timeline revision",
      { timeline_revision: timelineView.revision, base_revision: baseView?.revision ?? 0 },
    );
  }
  if (timeline.blocks.length > 24 || timeline.blocks.some(block => block.entries.length > 50 || block.entries.some(entry => entry.detail.length > 2_000))) {
    throw new OperatorExecutionFailure(
      "daily_summary_content_limit_exceeded",
      "Daily Summary formation cannot preserve all Timeline blocks within the strict output Schema",
      {
        block_count: timeline.blocks.length,
        largest_block_entries: Math.max(...timeline.blocks.map(block => block.entries.length)),
      },
    );
  }

  const entryCount = timeline.blocks.reduce((total, block) => total + block.entries.length, 0);
  const leadingTopic = timeline.signals.top_topics[0] ?? "Personal activity";
  const value = {
    version: 1,
    date: timeline.date,
    headline: `${leadingTopic} shaped the day`,
    overview: `${timeline.blocks.length} activity blocks bring together ${entryCount} exact source Views. ${timeline.blocks[0]!.summary}`,
    themes: timeline.blocks.map(block => ({
      title: block.title,
      narrative: block.summary,
      highlights: block.entries.map(entry => entry.detail),
    })),
    decisions: timeline.signals.decisions,
    unfinished_threads: timeline.signals.unfinished_threads,
    tomorrow: timeline.signals.unfinished_threads,
    source_timeline: exactViewRef(timelineView),
  };
  const inputs = invocation.inputs.flatMap(binding => binding.views);
  const viewId = baseView?.id ?? `${configuration.output_view_prefix}:${timeline.date}`;
  const candidate = candidateView(invocation, {
    id: viewId,
    name: `Daily Summary · ${timeline.date}`,
    purpose: "Readable synthesis of the day's themes, decisions, and open threads",
    representationKind: PERSONAL_DAILY_SUMMARY_REPRESENTATION,
    value,
    inputs,
    base: baseView,
    metadata: { processor: "personal.summary.daily@1", source_timeline_revision: timelineView.revision },
  });

  await context.emit({
    type: "personal_activity.daily_summary.formed",
    payload: {
      date: timeline.date,
      timeline_revision: timelineView.revision,
      theme_count: value.themes.length,
      base_revision: baseView?.revision ?? 0,
    },
  });
  context.signal.throwIfAborted();
  return { outputs: [candidate], diagnostics: { date: timeline.date, theme_count: value.themes.length, entry_count: entryCount } };
}

function assertFunction(
  invocation: OperatorExecutionInvocation,
  reference: unknown,
  outputSchema: { name: string; version: number },
  label: string,
): void {
  if (canonicalJson(invocation.run.frozen.transformation.operator.reference) !== canonicalJson(JsonValueSchema.parse(reference))) {
    throw new OperatorExecutionFailure("personal_activity_operator_mismatch", `Personal Activity ${label} Worker received a different frozen Function Operator`);
  }
  const frozenOutput = invocation.run.frozen.transformation.output.schema;
  if (frozenOutput.name !== outputSchema.name || frozenOutput.version !== outputSchema.version || frozenOutput.mode !== "strict") {
    throw new OperatorExecutionFailure("personal_activity_output_schema_mismatch", `Personal Activity ${label} Worker requires its exact strict output Schema`);
  }
}

function parseConfiguration<T>(schema: z.ZodType<T>, invocation: OperatorExecutionInvocation, label: string): T {
  const parsed = schema.safeParse(invocation.run.frozen.transformation.operator.configuration);
  if (!parsed.success) {
    throw new OperatorExecutionFailure(
      "personal_activity_configuration_invalid",
      `Personal Activity ${label} Worker configuration is invalid`,
      { issue_count: parsed.error.issues.length },
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function roleViews(
  invocation: OperatorExecutionInvocation,
  role: string,
  limits: { min: number; max?: number },
): View[] {
  const bindings = invocation.inputs.filter(binding => binding.role === role);
  const views = bindings.flatMap(binding => binding.views);
  if (bindings.length > 1 || views.length < limits.min || (limits.max !== undefined && views.length > limits.max)) {
    throw new OperatorExecutionFailure(
      "personal_activity_input_invalid",
      `Personal Activity role ${role} violates its frozen cardinality`,
      { binding_count: bindings.length, view_count: views.length, minimum: limits.min, maximum: limits.max ?? -1 },
    );
  }
  return views;
}

function assertNoUnexpectedRoles(invocation: OperatorExecutionInvocation, allowed: Set<string>, label: string): void {
  const unexpected = invocation.inputs.filter(binding => binding.views.length > 0 && !allowed.has(binding.role));
  if (unexpected.length > 0) {
    throw new OperatorExecutionFailure(
      "personal_activity_input_invalid",
      `Personal Activity ${label} Worker received an unexpected input role`,
      { unexpected_role_count: unexpected.length },
    );
  }
}

function assertUniqueExactViews(views: View[], code: string): void {
  const keys = views.map(view => refKey(exactViewRef(view)));
  if (new Set(keys).size !== keys.length) {
    throw new OperatorExecutionFailure(code, "Personal Activity Worker received duplicate exact View revisions", { view_count: views.length });
  }
}

function readAudio(view: View): AudioValue {
  assertSchema(view, PERSONAL_AUDIO_SCHEMA, PERSONAL_AUDIO_REPRESENTATION);
  const value = inlineObject(view);
  const startedAt = timestampField(value, "started_at");
  const endedAt = timestampField(value, "ended_at");
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    throw new OperatorExecutionFailure("personal_activity_time_invalid", "Audio View ended_at must not precede started_at", { view_id: view.id, revision: view.revision });
  }
  return {
    started_at: startedAt,
    ended_at: endedAt,
    summary: stringField(value, "summary"),
    topics: stringArray(value, "topics"),
    decisions: stringArray(value, "decisions"),
    action_items: stringArray(value, "action_items"),
  };
}

function readTimeline(view: View): TimelineValue {
  assertSchema(view, PERSONAL_TIMELINE_SCHEMA, PERSONAL_TIMELINE_REPRESENTATION);
  const timeline = inlineObject(view) as unknown as TimelineValue;
  if (!isTimeZone(timeline.timezone) || timeline.blocks.some(block => !validRange(block.started_at, block.ended_at))) {
    throw new OperatorExecutionFailure("personal_activity_time_invalid", "Activity Timeline contains an invalid timezone or time range", { view_id: view.id, revision: view.revision });
  }
  return timeline;
}

function readDailySummary(view: View): { date: string; source_timeline: ExactViewRef } {
  assertSchema(view, PERSONAL_DAILY_SUMMARY_SCHEMA, PERSONAL_DAILY_SUMMARY_REPRESENTATION);
  const value = inlineObject(view);
  const source = objectField(value, "source_timeline");
  const revision = source.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new OperatorExecutionFailure("personal_activity_representation_invalid", "Daily Summary source_timeline revision is invalid");
  }
  return { date: stringField(value, "date"), source_timeline: { view_id: stringField(source, "view_id"), revision } };
}

function assertSchema(view: View, schema: { name: string; version: number }, representationKind: string): void {
  if (view.schema.name !== schema.name || view.schema.version !== schema.version) {
    throw new OperatorExecutionFailure(
      "personal_activity_input_schema_mismatch",
      `Personal Activity Worker cannot consume ${view.schema.name}@${view.schema.version}`,
      { view_id: view.id, revision: view.revision },
    );
  }
  if (view.representation.kind !== representationKind) {
    throw new OperatorExecutionFailure(
      "personal_activity_representation_mismatch",
      `Personal Activity Worker requires Representation kind ${representationKind}`,
      { view_id: view.id, revision: view.revision },
    );
  }
}

function inlineObject(view: View): JsonObject {
  if (view.representation.form !== "inline" || !isObject(view.representation.value)) {
    throw new OperatorExecutionFailure(
      "personal_activity_representation_invalid",
      "Personal Activity Worker requires an inline object Representation",
      { view_id: view.id, revision: view.revision },
    );
  }
  return view.representation.value;
}

function candidateView(
  invocation: OperatorExecutionInvocation,
  input: {
    id: string;
    name: string;
    purpose: string;
    representationKind: string;
    value: JsonValue;
    inputs: View[];
    base?: View;
    metadata: JsonObject;
  },
): { draft: ViewDraft; expected_revision: number; idempotency_key: string } {
  const refs = input.inputs.map(exactViewRef);
  const policy = inheritStrictestViewPolicy(input.inputs.map(view => view.policy));
  return {
    draft: {
      id: input.id,
      name: input.name,
      purpose: input.purpose,
      aliases: [],
      schema: invocation.run.frozen.transformation.output.schema,
      role: "derived",
      time: { created_at: invocation.attempt.started_at },
      representation: { form: "inline", kind: input.representationKind, media_type: "application/json", value: input.value, metadata: {} },
      materialization: {
        primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
        alternatives: [],
      },
      relations: [
        ...refs.map(target => ({ type: "derived_from", target, metadata: {} })),
        ...(input.base ? [{ type: "supersedes", target: exactViewRef(input.base), metadata: {} }] : []),
      ],
      provenance: {
        inputs: refs,
        operator_run_id: invocation.run.id,
        actor: functionActor(invocation),
        trace_id: invocation.run.trace_id,
      },
      policy,
      metadata: input.metadata,
    },
    expected_revision: input.base?.revision ?? 0,
    idempotency_key: `${invocation.run.id}:output`,
  };
}

function localDate(timestamp: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function stringField(value: JsonObject, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new OperatorExecutionFailure("personal_activity_representation_invalid", `Personal Activity field ${key} must be a string`);
  return field;
}

function timestampField(value: JsonObject, key: string): string {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) {
    throw new OperatorExecutionFailure("personal_activity_time_invalid", `Personal Activity field ${key} is not a valid timestamp`);
  }
  return field;
}

function stringArray(value: JsonObject, key: string): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some(item => typeof item !== "string")) {
    throw new OperatorExecutionFailure("personal_activity_representation_invalid", `Personal Activity field ${key} must be a string array`);
  }
  return field as string[];
}

function objectField(value: JsonObject, key: string): JsonObject {
  const field = value[key];
  if (!isObject(field)) throw new OperatorExecutionFailure("personal_activity_representation_invalid", `Personal Activity field ${key} must be an object`);
  return field;
}

function isObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function validRange(startedAt: string, endedAt: string): boolean {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start;
}

function functionActor(invocation: OperatorExecutionInvocation): string {
  const reference = invocation.run.frozen.transformation.operator.reference;
  if (reference.kind !== "function") throw new Error("Personal Activity Function Worker lost its frozen Function reference");
  return `function:${reference.function_id}@${reference.version}`;
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}
