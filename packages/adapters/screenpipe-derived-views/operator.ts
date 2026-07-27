import { createHash } from "node:crypto";
import {
  OperatorExecutionFailure,
  inheritStrictestViewPolicy,
  type OperatorCandidateEnvelope,
  type OperatorExecutionInvocation,
} from "@info/execution";
import { canonicalJson, exactViewRef, type JsonObject, type JsonValue, type View } from "@info/view";
import {
  SCREENPIPE_AUDIO_FUNCTION,
  SCREENPIPE_AUDIO_SCHEMA,
  SCREENPIPE_TIMELINE_FUNCTION,
  SCREENPIPE_TIMELINE_SCHEMA,
  ScreenpipeDerivedConfigurationSchema,
  ScreenpipeSourceValueSchema,
} from "./contracts.js";

type TimelineModality = "screen" | "audio" | "input" | "accessibility" | "element" | "activity";
type TimelineEntry = JsonObject & { modality: TimelineModality };

const TIMELINE_SCHEMAS: ReadonlyMap<string, {
  modality: TimelineModality;
  itemType: string;
  representationKind: string;
  assertion: "direct" | "source_derived";
}> = new Map([
  ["capture.screenpipe.frame_ocr", {
    modality: "screen", itemType: "OCR", representationKind: "screenpipe_frame_ocr", assertion: "direct",
  }],
  ["capture.screenpipe.audio", {
    modality: "audio", itemType: "Audio", representationKind: "screenpipe_audio_transcription", assertion: "direct",
  }],
  ["capture.screenpipe.input", {
    modality: "input", itemType: "Input", representationKind: "screenpipe_input", assertion: "direct",
  }],
  ["capture.screenpipe.ui_accessibility", {
    modality: "accessibility", itemType: "UI", representationKind: "screenpipe_ui_accessibility", assertion: "direct",
  }],
  ["capture.screenpipe.ui_element", {
    modality: "element", itemType: "Element", representationKind: "screenpipe_ui_element", assertion: "direct",
  }],
  ["capture.screenpipe.activity_summary", {
    modality: "activity", itemType: "ActivitySummary", representationKind: "screenpipe_activity_summary", assertion: "source_derived",
  }],
] as const);

export function executeScreenpipeTimeline(invocation: OperatorExecutionInvocation): OperatorCandidateEnvelope {
  assertInvocation(invocation, SCREENPIPE_TIMELINE_FUNCTION, SCREENPIPE_TIMELINE_SCHEMA);
  const configuration = parseConfiguration(invocation);
  const inputs = sourceViews(invocation, new Set(TIMELINE_SCHEMAS.keys()));
  assertPeriod(inputs, configuration.period);
  const entries = inputs.map(view => timelineEntry(view));
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.modality] = (counts[entry.modality] ?? 0) + 1;
  return envelope(invocation, configuration, inputs, SCREENPIPE_TIMELINE_SCHEMA, "screenpipe_timeline", {
    contract_version: 1,
    period: configuration.period,
    sources: inputs.map(view => ({ relation: "derived_from", view: exactViewRef(view) })),
    entries,
    stats: { source_count: inputs.length, counts_by_modality: counts },
  });
}

export function executeScreenpipeAudio(invocation: OperatorExecutionInvocation): OperatorCandidateEnvelope {
  assertInvocation(invocation, SCREENPIPE_AUDIO_FUNCTION, SCREENPIPE_AUDIO_SCHEMA);
  const configuration = parseConfiguration(invocation);
  const inputs = sourceViews(invocation, new Set(["capture.screenpipe.audio"]));
  assertPeriod(inputs, configuration.period);
  const segments = inputs.map(view => {
    const content = sourceContent(view);
    const normalized = normalizeText(stringValue(content.transcription) ?? stringValue(content.text));
    if (!normalized) {
      throw new OperatorExecutionFailure(
        "screenpipe_audio_transcript_unavailable",
        `Screenpipe Audio Raw View ${view.id}@${view.revision} has no completed transcript`,
      );
    }
    if (normalized.length > 20_000) {
      throw new OperatorExecutionFailure(
        "screenpipe_audio_transcript_too_large",
        `Screenpipe Audio Raw View ${view.id}@${view.revision} exceeds the segment text bound`,
      );
    }
    const deviceType = content.device_type;
    if (deviceType !== "Input" && deviceType !== "Output") {
      throw new OperatorExecutionFailure("screenpipe_audio_device_invalid", "Screenpipe Audio View requires Input or Output device evidence");
    }
    const speaker = objectValue(content.speaker);
    return {
      at: observedAt(view),
      source: exactViewRef(view),
      text: normalized,
      device_type: deviceType,
      ...optional("device_name", stringValue(content.device_name), 500),
      ...optional("speaker", stringValue(speaker?.name), 500),
      ...audioOffsets(content),
    };
  });
  const transcript = segments.map(segment => segment.text).join("\n");
  if (transcript.length > 500_000) {
    throw new OperatorExecutionFailure(
      "screenpipe_audio_transcript_too_large",
      "Screenpipe Audio transcript exceeds the aggregate text bound",
    );
  }
  return envelope(invocation, configuration, inputs, SCREENPIPE_AUDIO_SCHEMA, "screenpipe_audio", {
    contract_version: 1,
    period: configuration.period,
    sources: inputs.map(view => ({ relation: "derived_from", view: exactViewRef(view) })),
    segments,
    transcript,
    stats: {
      source_count: inputs.length,
      segment_count: segments.length,
      input_segments: segments.filter(segment => segment.device_type === "Input").length,
      output_segments: segments.filter(segment => segment.device_type === "Output").length,
    },
  });
}

function envelope(
  invocation: OperatorExecutionInvocation,
  configuration: ReturnType<typeof parseConfiguration>,
  inputs: View[],
  schema: typeof SCREENPIPE_TIMELINE_SCHEMA,
  representationKind: string,
  value: JsonObject,
): OperatorCandidateEnvelope {
  const refs = inputs.map(exactViewRef).sort((left, right) => (
    left.view_id.localeCompare(right.view_id) || left.revision - right.revision
  ));
  const identity = createHash("sha256").update(canonicalJson({ configuration, refs })).digest("hex");
  return {
    outputs: [{
      draft: {
        id: configuration.output_view_id,
        name: representationKind === "screenpipe_audio" ? "Screenpipe Audio View" : "Screenpipe Timeline View",
        purpose: representationKind === "screenpipe_audio"
          ? "Compress exact Screenpipe audio evidence into a searchable transcript timeline"
          : "Compress exact Screenpipe multimodal evidence into a bounded chronological timeline",
        aliases: [],
        schema,
        role: "derived",
        time: { observed_at: configuration.period.end, created_at: invocation.attempt.started_at },
        representation: { form: "inline", kind: representationKind, media_type: "application/json", value, metadata: {} },
        materialization: {
          primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
          alternatives: [],
        },
        relations: refs.map(target => ({ type: "derived_from", target, metadata: {} })),
        provenance: {
          inputs: refs,
          operator_run_id: invocation.run.id,
          actor: `function:${invocation.run.frozen.transformation.operator.reference.kind === "function"
            ? invocation.run.frozen.transformation.operator.reference.function_id
            : "invalid"}@1`,
          trace_id: invocation.run.trace_id,
        },
        policy: inheritStrictestViewPolicy(inputs.map(view => view.policy)),
        metadata: { source: "screenpipe", compression_contract: 1 },
      },
      expected_revision: configuration.expected_revision,
      idempotency_key: `screenpipe-derived:${identity}`,
    }],
    diagnostics: { source_count: inputs.length },
  };
}

function timelineEntry(view: View): TimelineEntry {
  const content = sourceContent(view);
  const sourceContract = TIMELINE_SCHEMAS.get(view.schema.name);
  if (!sourceContract) throw new OperatorExecutionFailure("screenpipe_timeline_schema_invalid", `Unsupported Timeline source ${view.schema.name}`);
  const normalizedText = normalizeText(
    stringValue(content.transcription) ?? stringValue(content.text) ?? stringValue(content.text_content),
  );
  return {
    at: observedAt(view),
    modality: sourceContract.modality,
    source: exactViewRef(view),
    label: view.name,
    ...(normalizedText ? { text: normalizedText.slice(0, 500) } : {}),
    ...optional("app", stringValue(content.app_name), 500),
    ...optional("window", stringValue(content.window_name) ?? stringValue(content.window_title), 500),
    ...optional("url", stringValue(content.browser_url), 2_000),
  };
}

function sourceViews(invocation: OperatorExecutionInvocation, allowedSchemas: Set<string>): View[] {
  const bindings = invocation.inputs.filter(binding => binding.role === "source");
  const unexpected = invocation.inputs.filter(binding => binding.role !== "source" && binding.views.length > 0);
  if (bindings.length !== 1 || bindings[0]!.views.length === 0 || unexpected.length > 0) {
    throw new OperatorExecutionFailure("screenpipe_derived_input_invalid", "Screenpipe derived Views require one non-empty source role");
  }
  if (bindings[0]!.views.length > 500) {
    throw new OperatorExecutionFailure("screenpipe_derived_input_too_large", "Screenpipe derived Views accept at most 500 exact inputs");
  }
  return [...bindings[0]!.views]
    .map(view => {
      if (view.role !== "raw" || view.schema.version !== 1 || view.schema.mode !== "freeform"
        || !allowedSchemas.has(view.schema.name)) {
        throw new OperatorExecutionFailure("screenpipe_derived_source_invalid", `Unsupported Screenpipe Raw View ${view.schema.name}`);
      }
      const source = sourceValue(view);
      const sourceContract = TIMELINE_SCHEMAS.get(view.schema.name);
      if (!sourceContract || source.item_type !== sourceContract.itemType
        || view.representation.kind !== sourceContract.representationKind
        || view.provenance.capture?.connector !== "screenpipe"
        || view.provenance.capture.assertion !== sourceContract.assertion) {
        throw new OperatorExecutionFailure(
          "screenpipe_derived_item_type_invalid",
          `Screenpipe Raw View ${view.schema.name} has incompatible item_type`,
        );
      }
      return view;
    })
    .sort((left, right) => Date.parse(observedAt(left)) - Date.parse(observedAt(right))
      || canonicalJson(exactViewRef(left)).localeCompare(canonicalJson(exactViewRef(right))));
}

function sourceContent(view: View): Record<string, JsonValue> {
  return sourceValue(view).content;
}

function sourceValue(view: View) {
  if (view.representation.form !== "inline") {
    throw new OperatorExecutionFailure("screenpipe_derived_representation_invalid", "Screenpipe derived Views require inline Raw View evidence");
  }
  const parsed = ScreenpipeSourceValueSchema.safeParse(view.representation.value);
  if (!parsed.success) {
    throw new OperatorExecutionFailure("screenpipe_derived_representation_invalid", "Screenpipe Raw View representation changed shape", {
      issue_count: parsed.error.issues.length,
    });
  }
  return parsed.data;
}

function parseConfiguration(invocation: OperatorExecutionInvocation) {
  const parsed = ScreenpipeDerivedConfigurationSchema.safeParse(invocation.run.frozen.transformation.operator.configuration);
  if (!parsed.success) {
    throw new OperatorExecutionFailure("screenpipe_derived_configuration_invalid", "Screenpipe derived configuration is invalid", {
      issue_count: parsed.error.issues.length,
    });
  }
  return parsed.data;
}

function assertInvocation(invocation: OperatorExecutionInvocation, reference: object, schema: object): void {
  if (canonicalJson(invocation.run.frozen.transformation.operator.reference) !== canonicalJson(reference)) {
    throw new OperatorExecutionFailure("screenpipe_derived_operator_mismatch", "Screenpipe derived Operator reference mismatch");
  }
  if (canonicalJson(invocation.run.frozen.transformation.output.schema) !== canonicalJson(schema)) {
    throw new OperatorExecutionFailure("screenpipe_derived_output_mismatch", "Screenpipe derived output Schema mismatch");
  }
}

function observedAt(view: View): string {
  return view.time.observed_at ?? view.time.created_at;
}

function assertPeriod(inputs: View[], period: { start: string; end: string }): void {
  const start = Date.parse(period.start);
  const end = Date.parse(period.end);
  const outside = inputs.find(view => {
    const observed = Date.parse(observedAt(view));
    return observed < start || observed > end;
  });
  if (outside) {
    throw new OperatorExecutionFailure(
      "screenpipe_derived_input_outside_period",
      `Screenpipe Raw View ${outside.id}@${outside.revision} falls outside the frozen period`,
    );
  }
}

function normalizeText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function objectValue(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function optional(key: string, value: string | undefined, maximum: number): JsonObject {
  const compact = normalizeText(value)?.slice(0, maximum);
  return compact ? { [key]: compact } : {};
}

function audioOffsets(content: Record<string, JsonValue>): JsonObject {
  const start = audioOffset(content.start_time, "start_time");
  const end = audioOffset(content.end_time, "end_time");
  if (start !== undefined && end !== undefined && end < start) {
    throw new OperatorExecutionFailure("screenpipe_audio_offset_invalid", "Screenpipe audio end_time precedes start_time");
  }
  return {
    ...(start === undefined ? {} : { start_seconds: start }),
    ...(end === undefined ? {} : { end_seconds: end }),
  };
}

function audioOffset(value: JsonValue | undefined, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new OperatorExecutionFailure("screenpipe_audio_offset_invalid", `Screenpipe audio ${field} is invalid`);
  }
  return value;
}
