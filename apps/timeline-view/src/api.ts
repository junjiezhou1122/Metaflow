import { z } from "zod";

const ExactRefSchema = z.object({ view_id: z.string().min(1), revision: z.number().int().positive() }).strict();

const OperationEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), request_id: z.string(), operation: z.string(), data: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    request_id: z.string(),
    operation: z.string().optional(),
    error: z.object({ code: z.string(), message: z.string(), category: z.string(), details: z.record(z.unknown()) }).strict(),
  }).strict(),
]);

const TimelineInfoSchema = z.object({
  ok: z.literal(true),
  connection_id: z.string().min(1),
  generation: z.number().int().positive(),
  index_view_id: z.string().min(1),
  timezone: z.string().min(1),
}).strict();

const TimelineValueSchema = z.object({
  at: z.string(),
  modality: z.enum(["screen", "audio", "input", "accessibility", "element", "activity"]),
  title: z.string(),
  text: z.string().optional(),
  app: z.string().optional(),
  window: z.string().optional(),
  url: z.string().optional(),
  focused: z.boolean().optional(),
  device_type: z.string().optional(),
  device_name: z.string().optional(),
  image: z.object({ kind: z.literal("screenpipe_frame"), frame_id: z.number().int(), view: ExactRefSchema }).strict().optional(),
}).strict();

const TimelineResponseSchema = z.object({
  contract_version: z.literal(1),
  subject: ExactRefSchema,
  profile: z.object({ id: z.literal("screenpipe.timeline.entries"), version: z.literal(1) }).strict(),
  items: z.array(z.object({ key: z.string(), evidence: z.array(ExactRefSchema).min(1), value: TimelineValueSchema }).strict()),
  next_cursor: z.string().optional(),
  redacted_boundary: z.boolean(),
}).strict();

export type ExactRef = z.infer<typeof ExactRefSchema>;
export type TimelineEntry = z.infer<typeof TimelineValueSchema> & { key: string; evidence: ExactRef[] };

export type TimelineFilters = {
  modalities: Array<TimelineEntry["modality"]>;
  app?: string;
  text?: string;
  hasImage: boolean;
  focused: boolean;
};

export class TimelineClientError extends Error {
  constructor(message: string, readonly code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TimelineClientError";
  }
}

export class TimelineClient {
  async info(signal?: AbortSignal) {
    return TimelineInfoSchema.parse(await json("/ambient/v1/timeline", { signal }));
  }

  async resolveLatest(viewId: string, signal?: AbortSignal): Promise<ExactRef> {
    return ExactRefSchema.parse(await this.operation("view.resolve.latest", { view_id: viewId }, signal));
  }

  async page(input: {
    subject: ExactRef;
    date: string;
    timezone: string;
    filters: TimelineFilters;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ entries: TimelineEntry[]; nextCursor?: string; redactedBoundary: boolean }> {
    const period = localDatePeriod(input.date, input.timezone);
    const filters = {
      ...(input.filters.modalities.length === 6 ? {} : { modalities: input.filters.modalities }),
      ...(input.filters.app ? { apps: [input.filters.app] } : {}),
      ...(input.filters.text ? { text: input.filters.text } : {}),
      ...(input.filters.hasImage ? { has_image: true } : {}),
      ...(input.filters.focused ? { focused: true } : {}),
    };
    const response = TimelineResponseSchema.parse(await this.operation("view.query", {
      request: {
        contract_version: 1,
        subject: input.subject,
        profile: { id: "screenpipe.timeline.entries", version: 1 },
        parameters: { period: { ...period, timezone: input.timezone }, filters, order: "descending" },
        page: { limit: input.limit ?? 50, ...(input.cursor ? { cursor: input.cursor } : {}) },
      },
    }, input.signal));
    return {
      entries: response.items.map(item => ({ key: item.key, evidence: item.evidence, ...item.value })),
      ...(response.next_cursor ? { nextCursor: response.next_cursor } : {}),
      redactedBoundary: response.redacted_boundary,
    };
  }

  async pull(connectionId: string, expectedGeneration: number, signal?: AbortSignal): Promise<void> {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 60_000);
    await this.operation("capture.connection.run", {
      connection_id: connectionId,
      expected_generation: expectedGeneration,
      idempotency_key: `timeline:refresh:${globalThis.crypto.randomUUID()}`,
      delivery: "pull",
      parameters: {
        resource: "search",
        query: {
          content_types: ["ocr", "audio", "input", "accessibility"],
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          limit: 50,
          max_content_length: 100_000,
        },
      },
    }, signal);
  }

  thumbnailUrl(ref: ExactRef, width: number): string {
    const query = new URLSearchParams({
      view_id: ref.view_id,
      revision: String(ref.revision),
      width: String(width),
    });
    return `/metaflow/v1/assets/screenpipe-frame-thumbnail?${query}`;
  }

  private async operation(operation: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const envelope = OperationEnvelopeSchema.parse(await json(`/metaflow/v1/operations/${encodeURIComponent(operation)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    }));
    if (!envelope.ok) throw new TimelineClientError(envelope.error.message, envelope.error.code);
    if (envelope.operation !== operation) throw new TimelineClientError("Operation identity mismatch", "invalid_response");
    return envelope.data;
  }
}

export function thumbnailRequestWidth(cssWidth: number, devicePixelRatio: number): number {
  const safeCssWidth = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 720;
  const safePixelRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? Math.min(devicePixelRatio, 2)
    : 1;
  const requested = Math.ceil((safeCssWidth * safePixelRatio) / 240) * 240;
  return Math.max(384, Math.min(1920, requested));
}

export function todayInputValue(
  now = new Date(),
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const parts = dateTimeParts(now, timezone);
  return `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
}

export function localDatePeriod(date: string, timezone: string): { start: string; end: string } {
  const startDate = parseCalendarDate(date);
  assertTimezone(timezone);
  const endDateValue = new Date(Date.UTC(startDate.year, startDate.month - 1, startDate.day + 1));
  const endDate = {
    year: endDateValue.getUTCFullYear(),
    month: endDateValue.getUTCMonth() + 1,
    day: endDateValue.getUTCDate(),
  };
  return {
    start: zonedMidnight(startDate, timezone).toISOString(),
    end: zonedMidnight(endDate, timezone).toISOString(),
  };
}

type CalendarDate = { year: number; month: number; day: number };

function parseCalendarDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new TimelineClientError("Date is invalid", "invalid_date");
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (check.getUTCFullYear() !== date.year || check.getUTCMonth() + 1 !== date.month || check.getUTCDate() !== date.day) {
    throw new TimelineClientError("Date is invalid", "invalid_date");
  }
  return date;
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch (cause) {
    throw new TimelineClientError("Timeline timezone is invalid", "invalid_timezone", { cause });
  }
}

function zonedMidnight(date: CalendarDate, timezone: string): Date {
  const wallTime = Date.UTC(date.year, date.month - 1, date.day);
  let instant = wallTime;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const offset = timezoneOffsetMilliseconds(new Date(instant), timezone);
    const next = wallTime - offset;
    if (next === instant) break;
    instant = next;
  }
  const result = new Date(instant);
  const parts = dateTimeParts(result, timezone);
  if (parts.year !== date.year || parts.month !== date.month || parts.day !== date.day || parts.hour !== 0 || parts.minute !== 0) {
    throw new TimelineClientError("Date has no midnight in the Timeline timezone", "invalid_date_boundary");
  }
  return result;
}

function timezoneOffsetMilliseconds(instant: Date, timezone: string): number {
  const parts = dateTimeParts(instant, timezone);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant.getTime();
}

function dateTimeParts(instant: Date, timezone: string) {
  const values = new Map<string, string>(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant).map(part => [part.type, part.value]));
  const read = (key: string) => Number(values.get(key));
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour"), minute: read("minute"), second: read("second") };
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

async function json(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (cause) {
    if (init.signal?.aborted) throw cause;
    throw new TimelineClientError("Timeline service is unreachable", "network_failed", { cause });
  }
  const body = await response.json().catch(cause => {
    throw new TimelineClientError("Timeline service returned invalid JSON", "invalid_response", { cause });
  });
  if (!response.ok) {
    const failure = z.object({
      error: z.object({ code: z.string(), message: z.string() }).passthrough(),
    }).passthrough().safeParse(body);
    if (failure.success) {
      throw new TimelineClientError(failure.data.error.message, failure.data.error.code);
    }
    const error = body as { code?: unknown; error?: unknown };
    throw new TimelineClientError(
      typeof error.error === "string" ? error.error : `Timeline request failed with HTTP ${response.status}`,
      typeof error.code === "string" ? error.code : "http_failed",
    );
  }
  return body;
}
