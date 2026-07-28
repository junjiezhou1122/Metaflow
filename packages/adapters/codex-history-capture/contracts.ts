import { z } from "zod";

export const CODEX_ROLLOUT_PARSER_CONTRACT = "codex-rollout-jsonl@0.145-safe-v4" as const;
export const CODEX_SECRET_POLICY = "secretlint-recommend@13+codex-structural-v1" as const;
export const CODEX_CURSOR_VERSION = 1 as const;
export const CODEX_MAX_BATCH_RECORDS = 256;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IdentifierSchema = z.string().trim().min(1).max(512);
const TimestampSchema = z.string().datetime({ offset: true });
const SafeRelativePathSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some(part => part === ".." || part === "")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Path must be a normalized relative POSIX path" });
  }
});

export const CodexHistoryConfigurationSchema = z.object({
  source_root: z.enum(["sessions", "archived_sessions", "both"]),
  content_mode: z.literal("messages"),
  max_record_bytes: z.number().int().min(1).max(8_000_000),
  max_files: z.number().int().min(1).max(20_000),
  secret_policy: z.literal(CODEX_SECRET_POLICY),
}).strict();

export type CodexHistoryConfiguration = z.infer<typeof CodexHistoryConfigurationSchema>;

const RecordEvidenceSchema = z.object({
  byte_offset: z.number().int().nonnegative(),
  byte_length: z.number().int().positive(),
  record_sha256: Sha256Schema,
  timestamp: TimestampSchema,
  session_id: IdentifierSchema,
});

export const CodexSessionMetadataRecordSchema = RecordEvidenceSchema.extend({
  kind: z.literal("session_meta"),
  source: z.string().min(1).max(120),
  originator: z.string().min(1).max(120),
  cli_version: z.string().min(1).max(120),
  model_provider: z.string().min(1).max(120).optional(),
  workspace_path: z.string().min(1).max(4_096),
}).strict();

export const CodexMessageRecordSchema = RecordEvidenceSchema.extend({
  kind: z.literal("message"),
  turn_id: IdentifierSchema.optional(),
  role: z.enum(["user", "assistant"]),
  text_parts: z.array(z.string().max(1_000_000)).min(1).max(32),
  omitted_non_text_parts: z.number().int().nonnegative(),
}).strict();

export const CodexSafeRecordSchema = z.discriminatedUnion("kind", [
  CodexSessionMetadataRecordSchema,
  CodexMessageRecordSchema,
]);

export type CodexSafeRecord = z.infer<typeof CodexSafeRecordSchema>;
export type CodexSessionMetadataRecord = z.infer<typeof CodexSessionMetadataRecordSchema>;
export type CodexMessageRecord = z.infer<typeof CodexMessageRecordSchema>;

export const CODEX_EXCLUSION_CATEGORIES = [
  "developer_or_system_message",
  "reasoning",
  "tool_call",
  "tool_result",
  "world_state",
  "event_duplicate",
  "instruction_or_context",
  "token_or_rate_metadata",
  "compaction",
  "image_or_attachment",
] as const;

export type CodexExclusionCategory = typeof CODEX_EXCLUSION_CATEGORIES[number];

const ExcludedRecordCountsSchema = z.object({
  developer_or_system_message: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  tool_call: z.number().int().nonnegative(),
  tool_result: z.number().int().nonnegative(),
  world_state: z.number().int().nonnegative(),
  event_duplicate: z.number().int().nonnegative(),
  instruction_or_context: z.number().int().nonnegative(),
  token_or_rate_metadata: z.number().int().nonnegative(),
  compaction: z.number().int().nonnegative(),
  image_or_attachment: z.number().int().nonnegative(),
}).strict();

export function emptyCodexExcludedRecordCounts(): Record<CodexExclusionCategory, number> {
  return Object.fromEntries(CODEX_EXCLUSION_CATEGORIES.map(category => [category, 0])) as Record<CodexExclusionCategory, number>;
}

export const CodexHistorySourcePayloadSchema = z.object({
  version: z.literal(1),
  parser_contract: z.literal(CODEX_ROLLOUT_PARSER_CONTRACT),
  scope: z.enum(["sessions", "archived_sessions"]),
  relative_path: SafeRelativePathSchema,
  session_id: IdentifierSchema,
  from_offset: z.number().int().nonnegative(),
  through_offset: z.number().int().positive(),
  committed_prefix_sha256: Sha256Schema,
  observed_file_size: z.number().int().nonnegative(),
  observed_mtime_ms: z.number().nonnegative().finite(),
  records: z.array(CodexSafeRecordSchema).min(1).max(CODEX_MAX_BATCH_RECORDS),
  excluded_record_counts: ExcludedRecordCountsSchema,
}).strict().superRefine((payload, context) => {
  if (payload.through_offset <= payload.from_offset) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["through_offset"], message: "through_offset must advance" });
  }
  let previousOffset = -1;
  payload.records.forEach((record, index) => {
    if (record.session_id !== payload.session_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index, "session_id"], message: "Record session must match payload" });
    }
    if (record.byte_offset < payload.from_offset || record.byte_offset + record.byte_length > payload.through_offset) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index, "byte_offset"], message: "Record lies outside payload offsets" });
    }
    if (record.byte_offset <= previousOffset) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["records", index, "byte_offset"], message: "Record offsets must increase" });
    }
    previousOffset = record.byte_offset;
  });
});

export type CodexHistorySourcePayload = z.infer<typeof CodexHistorySourcePayloadSchema>;

export const CodexHistoryCursorFileSchema = z.object({
  scope: z.enum(["sessions", "archived_sessions"]),
  relative_path: SafeRelativePathSchema,
  session_id: IdentifierSchema,
  committed_offset: z.number().int().nonnegative(),
  committed_prefix_sha256: Sha256Schema,
  observed_size: z.number().int().nonnegative(),
}).strict();

export const CodexHistoryCursorSchema = z.object({
  version: z.literal(CODEX_CURSOR_VERSION),
  parser_contract: z.literal(CODEX_ROLLOUT_PARSER_CONTRACT),
  discovery_manifest_sha256: Sha256Schema,
  files: z.record(IdentifierSchema, CodexHistoryCursorFileSchema),
}).strict().superRefine((cursor, context) => {
  for (const [sessionId, file] of Object.entries(cursor.files)) {
    if (sessionId !== file.session_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files", sessionId, "session_id"],
        message: "Cursor file key must match its session_id",
      });
    }
  }
});

export type CodexHistoryCursor = z.infer<typeof CodexHistoryCursorSchema>;

export const CodexHistoryOpenParametersSchema = z.object({}).strict();
