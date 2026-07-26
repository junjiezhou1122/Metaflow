import { z } from "zod";
import { JsonValueSchema, ViewPolicySchema } from "@info/view";

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });

export const BrowserPageEventSchema = z.object({
  version: z.literal(1),
  event_id: IdentifierSchema,
  navigation_id: IdentifierSchema,
  tab_id: z.number().int().nonnegative(),
  window_id: z.number().int().nonnegative().optional(),
  occurred_at: TimestampSchema,
  captured_at: TimestampSchema,
  reason: z.enum(["dwell", "selection", "dom", "manual"]),
  url: z.string().url(),
  title: z.string().trim().min(1).max(500),
  domain: IdentifierSchema,
  dwell_ms: z.number().int().nonnegative(),
  scroll_depth: z.number().finite().min(0).max(1),
  scroll_events: z.number().int().nonnegative(),
  selection_count: z.number().int().nonnegative(),
  dom: z.object({
    github_repository: z.boolean().default(false),
    repository_owner: IdentifierSchema.optional(),
    repository_name: IdentifierSchema.optional(),
    markers: z.record(JsonValueSchema).default({}),
  }).strict(),
  page: z.object({
    text: z.string().trim().min(1).max(1_000_000),
    selected_text: z.string().trim().min(1).max(200_000).optional(),
    metadata: z.record(JsonValueSchema).default({}),
    text_quality: z.record(JsonValueSchema).default({}),
  }).strict(),
  source: z.object({
    connector: IdentifierSchema.default("chrome-extension"),
    connection_id: IdentifierSchema.default("chrome:default"),
  }).strict().default({}),
  policy: ViewPolicySchema,
}).strict().superRefine((event, context) => {
  let parsed: URL;
  try {
    parsed = new URL(event.url);
  } catch {
    return;
  }
  if (parsed.hostname !== event.domain) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "domain must match the event URL hostname",
      path: ["domain"],
    });
  }
  const githubPath = parsed.hostname === "github.com" && parsed.pathname.split("/").filter(Boolean).length >= 2;
  if (event.dom.github_repository && !githubPath) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "github_repository cannot be true for a non-repository URL",
      path: ["dom", "github_repository"],
    });
  }
  if (event.dom.github_repository && (!event.dom.repository_owner || !event.dom.repository_name)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "GitHub repository DOM evidence requires owner and repository name",
      path: ["dom"],
    });
  }
});

export type BrowserPageEvent = z.infer<typeof BrowserPageEventSchema>;

export class BrowserAutomationAdapterError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_browser_event"
      | "required_evidence_not_stored"
      | "capture_failed"
      | "automation_catalog_failed"
      | "automation_invocation_failed",
    readonly details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrowserAutomationAdapterError";
  }
}

export function parseBrowserPageEvent(input: unknown): BrowserPageEvent {
  const parsed = BrowserPageEventSchema.safeParse(input);
  if (!parsed.success) {
    throw new BrowserAutomationAdapterError(
      "invalid Browser page event",
      "invalid_browser_event",
      { issues: parsed.error.issues },
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
