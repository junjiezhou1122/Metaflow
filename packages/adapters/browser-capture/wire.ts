import { z } from "zod";
import { JsonValueSchema, ViewPolicySchema } from "@info/view/schema";

export const DEFAULT_BROWSER_CAPTURE_DAEMON_PORT = 3112;

const IdentifierSchema = z.string().trim().min(1).max(240);
const TimestampSchema = z.string().datetime({ offset: true });
const JsonObjectSchema = z.record(JsonValueSchema);

export const BrowserCaptureKindSchema = z.enum([
  "page",
  "navigation",
  "selection",
  "media",
  "interaction",
]);

export const BrowserCaptureActionSchema = z.enum([
  "page_snapshot",
  "page_saved",
  "navigation_opened",
  "navigation_committed",
  "navigation_history_state",
  "navigation_lifecycle",
  "selection",
  "copy",
  "media_caption",
  "media_caption_state",
  "media_paused",
  "media_played",
  "interaction_heartbeat",
  "interaction_search",
]);

export const BrowserAttentionSchema = z.enum(["focused", "background", "open"]);

export const BrowserCaptureEventSchema = z.object({
  version: z.literal(1),
  event_id: IdentifierSchema,
  kind: BrowserCaptureKindSchema,
  action: BrowserCaptureActionSchema,
  occurred_at: TimestampSchema,
  captured_at: TimestampSchema,
  source: z.object({
    connector: z.literal("chrome-extension").default("chrome-extension"),
    connection_id: IdentifierSchema,
  }).strict(),
  browser: z.object({
    tab_id: z.number().int().nonnegative(),
    window_id: z.number().int().nonnegative(),
    visit_id: IdentifierSchema,
    attention: BrowserAttentionSchema,
    tab_active: z.boolean(),
    window_focused: z.boolean(),
    document_id: IdentifierSchema.optional(),
    frame_id: z.number().int().nonnegative().optional(),
  }).strict(),
  navigation: z.object({
    navigation_id: IdentifierSchema,
    transition: z.enum(["opened", "committed", "history_state", "lifecycle"]),
    document_id: IdentifierSchema.optional(),
    frame_id: z.number().int().nonnegative(),
    parent_frame_id: z.number().int().min(-1).optional(),
  }).strict().optional(),
  page: z.object({
    url: z.string().url(),
    title: z.string().trim().min(1).max(500).optional(),
    domain: IdentifierSchema,
    canonical_url: z.string().url().optional(),
  }).strict().optional(),
  content: z.object({
    text: z.string().max(1_000_000).optional(),
    selected_text: z.string().trim().min(1).max(200_000).optional(),
    media_id: IdentifierSchema.optional(),
    media_url: z.string().url().optional(),
  }).strict().default({}),
  facts: JsonObjectSchema.default({}),
  policy: ViewPolicySchema,
}).strict().superRefine((event, context) => {
  if ((event.kind === "page" || event.kind === "navigation" || event.kind === "selection") && !event.page) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["page"], message: `${event.kind} capture requires page context` });
  }
  if (event.kind === "selection" && !event.content.selected_text) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content", "selected_text"], message: "selection capture requires selected_text" });
  }
  if (event.kind === "media" && !event.content.media_id && !event.content.media_url && !event.page) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "media capture requires a media identity or page" });
  }
  if (event.page) {
    const host = new URL(event.page.url).hostname;
    if (host !== event.page.domain) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["page", "domain"], message: "page domain must match the URL hostname" });
    }
  }
  const expectedKind = kindForAction(event.action);
  if (event.kind !== expectedKind) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: `${event.action} requires kind ${expectedKind}` });
  }
  if (event.kind === "navigation" && !event.navigation) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["navigation"], message: `${event.action} requires navigation identity` });
  }
  if (event.action === "navigation_committed" || event.action === "navigation_history_state") {
    if (!event.navigation?.document_id || event.browser.document_id !== event.navigation.document_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["navigation", "document_id"],
        message: `${event.action} requires one matching Browser document identity`,
      });
    }
    if (event.browser.frame_id !== event.navigation?.frame_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["navigation", "frame_id"],
        message: `${event.action} requires one matching Browser frame identity`,
      });
    }
  }
  if (event.action === "media_caption") {
    const hasSegmentId = typeof event.facts.segment_id === "string" && event.facts.segment_id.trim().length > 0;
    const hasTimeRange = typeof event.facts.start_seconds === "number"
      && Number.isFinite(event.facts.start_seconds)
      && typeof event.facts.end_seconds === "number"
      && Number.isFinite(event.facts.end_seconds)
      && event.facts.end_seconds >= event.facts.start_seconds;
    if (!hasSegmentId && !hasTimeRange) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["facts"],
        message: "media_caption requires segment_id or a finite start/end range",
      });
    }
  }
  if (event.action === "page_saved" && event.facts.user_intent !== "save_current_page") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["facts", "user_intent"],
      message: "page_saved requires explicit save_current_page intent",
    });
  }
  if (event.action === "interaction_heartbeat" && event.browser.attention !== "focused") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["browser", "attention"],
      message: "interaction_heartbeat requires focused Browser attention",
    });
  }
});

export type BrowserCaptureEvent = z.infer<typeof BrowserCaptureEventSchema>;
export type BrowserCaptureAction = z.infer<typeof BrowserCaptureActionSchema>;
export type BrowserCaptureKind = z.infer<typeof BrowserCaptureKindSchema>;
export type BrowserAttention = z.infer<typeof BrowserAttentionSchema>;

export function parseBrowserCaptureWireEvent(input: unknown): BrowserCaptureEvent {
  return BrowserCaptureEventSchema.parse(input);
}

function kindForAction(action: BrowserCaptureAction): BrowserCaptureKind {
  if (action === "page_snapshot" || action === "page_saved") return "page";
  if (action.startsWith("navigation_")) return "navigation";
  if (action === "selection" || action === "copy") return "selection";
  if (action.startsWith("media_")) return "media";
  return "interaction";
}
