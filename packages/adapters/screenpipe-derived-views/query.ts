import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ViewQueryError,
  ViewQueryMethodParametersContractSchema,
  ViewQueryProfileSchema,
  type ViewQueryItem,
  type ViewQueryMethod,
} from "@info/operations";
import { ScreenpipeSourceValueSchema } from "@info/screenpipe-contracts";
import {
  IdentifierSchema,
  TimestampSchema,
  exactViewRef,
  parseViewDraft,
  type ExactViewRef,
  type JsonObject,
  type JsonValue,
  type View,
  type ViewDraft,
  type ViewRepository,
  type ViewSchemaRef,
} from "@info/view";

export const ScreenpipeTimelineQueryParametersSchema = z.object({
  period: z.object({
    start: TimestampSchema,
    end: TimestampSchema,
    timezone: IdentifierSchema,
  }).strict().refine(period => Date.parse(period.start) < Date.parse(period.end), {
    message: "Timeline query period end must follow start",
    path: ["end"],
  }),
  filters: z.object({
    modalities: z.array(z.enum(["screen", "audio", "input", "accessibility", "element", "activity"]))
      .min(1).max(6).optional(),
    apps: z.array(z.string().trim().min(1).max(500)).min(1).max(32).optional(),
    text: z.string().trim().min(1).max(500).optional(),
    has_image: z.boolean().optional(),
    focused: z.boolean().optional(),
  }).strict().default({}),
  order: z.enum(["ascending", "descending"]).default("descending"),
}).strict();

const TimelineMethodCursorSchema = z.object({
  snapshot_commit_sequence: z.number().int().nonnegative(),
  after: z.object({
    timestamp: TimestampSchema,
    view_id: IdentifierSchema,
    revision: z.number().int().positive(),
  }).strict(),
}).strict();

const TimelineIndexValueSchema = z.object({
  contract_version: z.literal(1),
  connection_id: IdentifierSchema,
  timezone: IdentifierSchema,
  modalities: z.array(z.enum(["screen", "audio", "input", "accessibility", "element", "activity"]))
    .min(1).max(6),
}).strict();

const TimelineQueryMethodContractSchema = z.object({
  profile: ViewQueryProfileSchema,
  subject_schema: z.object({
    name: IdentifierSchema,
    version: z.number().int().positive(),
  }).strict(),
  parameters: ViewQueryMethodParametersContractSchema,
}).strict();

const SCHEMA_MODALITIES = new Map<string, TimelineModality>([
  ["capture.screenpipe.frame_ocr", "screen"],
  ["capture.screenpipe.audio", "audio"],
  ["capture.screenpipe.input", "input"],
  ["capture.screenpipe.ui_accessibility", "accessibility"],
  ["capture.screenpipe.ui_element", "element"],
  ["capture.screenpipe.activity_summary", "activity"],
]);

type TimelineModality = "screen" | "audio" | "input" | "accessibility" | "element" | "activity";

export class ScreenpipeTimelineQueryMethod implements ViewQueryMethod {
  readonly profile: ViewQueryMethod["profile"];
  readonly subject_schema: ViewQueryMethod["subject_schema"];
  readonly parameters: ViewQueryMethod["parameters"];

  constructor(
    private readonly views: Pick<ViewRepository, "query" | "getQuerySnapshot">,
    contract: z.input<typeof TimelineQueryMethodContractSchema>,
    options: { max_scan?: number } = {},
  ) {
    const parsedContract = TimelineQueryMethodContractSchema.parse(contract);
    this.profile = parsedContract.profile;
    this.subject_schema = parsedContract.subject_schema;
    this.parameters = parsedContract.parameters;
    this.maxScan = options.max_scan ?? 10_000;
    if (!Number.isInteger(this.maxScan) || this.maxScan < 100 || this.maxScan > 10_000) {
      throw new TypeError("Screenpipe Timeline max_scan must be an integer from 100 through 10000");
    }
  }

  private readonly maxScan: number;

  async query(input: Parameters<ViewQueryMethod["query"]>[0]) {
    const parameters = parseParameters(input.parameters);
    const index = timelineIndex(input.subject);
    const allowedModalities = new Set(index.modalities);
    const requestedModalities = new Set(parameters.filters.modalities ?? index.modalities);
    if ([...requestedModalities].some(modality => !allowedModalities.has(modality))) {
      throw new ViewQueryError("Timeline query requested a modality outside the subject definition", "view_query_method_invalid");
    }
    const candidateSchemaNames = [...SCHEMA_MODALITIES.entries()]
      .filter(([, modality]) => requestedModalities.has(modality)
        && (parameters.filters.has_image !== true || modality === "screen"))
      .map(([schemaName]) => schemaName);
    if (candidateSchemaNames.length === 0) {
      return { items: [], redacted_boundary: false };
    }
    const cursor = input.page.cursor === undefined
      ? { snapshot_commit_sequence: (await this.views.getQuerySnapshot()).commit_sequence, after: undefined }
      : parseCursor(input.page.cursor);
    const matches: Array<{ item: ViewQueryItem; after: NonNullable<typeof cursor.after> }> = [];
    let after = cursor.after;
    let scanned = 0;
    let exhausted = false;
    let redactedBoundary = false;

    while (matches.length < input.page.limit + 1 && !exhausted) {
      if (scanned >= this.maxScan) {
        break;
      }
      const batchLimit = Math.min(200, this.maxScan - scanned);
      const batch = await this.views.query({
        schema_names: candidateSchemaNames,
        role: "raw",
        capture_connection_id: index.connection_id,
        revisions: "latest",
        snapshot: { commit_sequence: cursor.snapshot_commit_sequence },
        time_range: { basis: "observed_at", start: parameters.period.start, end: parameters.period.end },
        order: { basis: "observed_at", direction: parameters.order },
        ...(after ? { after } : {}),
        limit: batchLimit,
      });
      if (batch.length === 0) {
        exhausted = true;
        break;
      }
      scanned += batch.length;
      const decisions = await input.authorize(batch.map(exactViewRef));
      const byRef = new Map(decisions.map(decision => [refKey(decision.ref), decision]));
      for (const view of batch) {
        const boundary = viewBoundary(view);
        after = boundary;
        const decision = byRef.get(refKey(exactViewRef(view)));
        if (decision?.status !== "allowed") {
          redactedBoundary = true;
          continue;
        }
        if (view.provenance.capture?.connection_id !== index.connection_id) {
          throw new ViewQueryError("Timeline repository crossed its declared connection filter", "view_query_method_invalid");
        }
        const modality = SCHEMA_MODALITIES.get(view.schema.name);
        if (!modality || !requestedModalities.has(modality)) continue;
        const item = projectTimelineItem(view, modality);
        if (!matchesFilters(item.value as JsonObject, parameters.filters)) continue;
        matches.push({ item, after: boundary });
        if (matches.length === input.page.limit + 1) break;
      }
      if (batch.length < batchLimit) exhausted = true;
    }

    const page = matches.slice(0, input.page.limit);
    const hasMoreMatches = matches.length > input.page.limit;
    const continuationAfter = hasMoreMatches ? page.at(-1)?.after : after;
    const hasContinuation = continuationAfter !== undefined && (hasMoreMatches || !exhausted);
    return {
      items: page.map(match => match.item),
      ...(hasContinuation ? {
        next_cursor: {
          snapshot_commit_sequence: cursor.snapshot_commit_sequence,
          after: continuationAfter,
        },
      } : {}),
      redacted_boundary: redactedBoundary,
    };
  }
}

export function createScreenpipeTimelineIndexDraft(input: {
  id?: string;
  schema: ViewSchemaRef;
  connection_id: string;
  timezone: string;
  modalities?: TimelineModality[];
  owner: string;
  created_at: string;
}): ViewDraft {
  return parseViewDraft({
    id: input.id ?? `view:screenpipe:timeline-index:${digest(input.connection_id).slice(0, 24)}`,
    name: "Screenpipe Timeline",
    purpose: "Browse a live authorized Screenpipe collection through typed date, modality, application, text, and media filters",
    schema: input.schema,
    role: "derived",
    time: { created_at: input.created_at },
    representation: {
      form: "inline",
      kind: "screenpipe_timeline_index",
      media_type: "application/json",
      value: {
        contract_version: 1,
        connection_id: input.connection_id,
        timezone: input.timezone,
        modalities: input.modalities ?? ["screen", "audio", "input", "accessibility"],
      },
    },
    materialization: {
      primary: { id: "canonical-json", format: "json", media_type: "application/json", location: { kind: "inline" } },
    },
    relations: [],
    provenance: { inputs: [], actor: "application:screenpipe-timeline" },
    policy: {
      owner: input.owner,
      visibility: "private",
      privacy: "private",
      retention: "normal",
      allow_external_model: false,
      allow_embedding: false,
      labels: ["screenpipe", "timeline", "collection"],
    },
  });
}

function parseParameters(value: JsonValue) {
  const parsed = ScreenpipeTimelineQueryParametersSchema.safeParse(value);
  if (!parsed.success) {
    throw new ViewQueryError("Screenpipe Timeline query parameters are invalid", "view_query_method_invalid", { cause: parsed.error });
  }
  return parsed.data;
}

function parseCursor(value: JsonValue): z.infer<typeof TimelineMethodCursorSchema> {
  const parsed = TimelineMethodCursorSchema.safeParse(value);
  if (!parsed.success) {
    throw new ViewQueryError("Screenpipe Timeline method cursor is invalid", "view_query_cursor_invalid", { cause: parsed.error });
  }
  return parsed.data;
}

function timelineIndex(view: View): z.infer<typeof TimelineIndexValueSchema> {
  if (view.representation.form !== "inline") {
    throw new ViewQueryError("Screenpipe Timeline index must be inline", "view_query_subject_mismatch");
  }
  const parsed = TimelineIndexValueSchema.safeParse(view.representation.value);
  if (!parsed.success) {
    throw new ViewQueryError("Screenpipe Timeline index Representation is invalid", "view_query_subject_mismatch", { cause: parsed.error });
  }
  return parsed.data;
}

function projectTimelineItem(view: View, modality: TimelineModality): ViewQueryItem {
  if (view.representation.form !== "inline") {
    throw new ViewQueryError("Screenpipe Timeline source must be inline", "view_query_method_invalid");
  }
  const parsed = ScreenpipeSourceValueSchema.safeParse(view.representation.value);
  if (!parsed.success) {
    throw new ViewQueryError("Screenpipe Timeline source changed shape", "view_query_method_invalid", { cause: parsed.error });
  }
  const content = parsed.data.content as Record<string, JsonValue>;
  const ref = exactViewRef(view);
  const text = normalizedText(stringValue(content.transcription) ?? stringValue(content.text) ?? stringValue(content.text_content));
  const app = stringValue(content.app_name);
  const window = stringValue(content.window_name) ?? stringValue(content.window_title);
  const url = stringValue(content.browser_url);
  const frameId = numberValue(content.frame_id);
  return {
    key: `timeline:${digest(refKey(ref)).slice(0, 32)}`,
    evidence: [ref],
    value: {
      at: view.time.observed_at ?? view.time.created_at,
      modality,
      title: view.name,
      ...(text ? { text: text.slice(0, 2_000) } : {}),
      ...(app ? { app: app.slice(0, 500) } : {}),
      ...(window ? { window: window.slice(0, 500) } : {}),
      ...(url ? { url: url.slice(0, 2_000) } : {}),
      ...(typeof content.focused === "boolean" ? { focused: content.focused } : {}),
      ...(modality === "audio" ? {
        device_type: content.device_type,
        ...(stringValue(content.device_name) ? { device_name: stringValue(content.device_name) } : {}),
      } : {}),
      ...(modality === "screen" && frameId !== undefined ? {
        image: { kind: "screenpipe_frame", frame_id: frameId, view: ref },
      } : {}),
    },
  };
}

function matchesFilters(value: JsonObject, filters: z.infer<typeof ScreenpipeTimelineQueryParametersSchema>["filters"]): boolean {
  if (filters.has_image !== undefined && Boolean(value.image) !== filters.has_image) return false;
  if (filters.focused !== undefined && value.focused !== filters.focused) return false;
  if (filters.apps) {
    const app = typeof value.app === "string" ? value.app.toLowerCase() : "";
    if (!filters.apps.some(candidate => app === candidate.toLowerCase())) return false;
  }
  if (filters.text) {
    const needle = filters.text.toLowerCase();
    const haystack = [value.title, value.text, value.app, value.window, value.url]
      .filter((entry): entry is string => typeof entry === "string")
      .join("\n")
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function viewBoundary(view: View) {
  return {
    timestamp: view.time.observed_at ?? view.time.created_at,
    view_id: view.id,
    revision: view.revision,
  };
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizedText(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized || undefined;
}

function refKey(ref: ExactViewRef): string {
  return `${ref.view_id}@${ref.revision}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
