import { z } from "zod";
import { CaptureIdentifierSchema, CaptureTimestampSchema } from "@info/capture";
import { JsonValueSchema } from "@info/view";

export const OBSIDIAN_CONNECTOR_ID = "obsidian-capture";
export const OBSIDIAN_CONNECTOR_VERSION = "1.0.0";
export const OBSIDIAN_PARSER_CONTRACT = "obsidian-markdown-safe-v1";
export const OBSIDIAN_SECRET_POLICY = "secretlint-recommend@13+frontmatter-v1";
export const OBSIDIAN_IDENTITY_POLICY = "registry+resource-id+unique-digest-v1";
export const OBSIDIAN_MAX_DOCUMENTS = 20_000;
export const OBSIDIAN_MAX_PRIOR_PATHS = 100;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const ObsidianSafeRelativePathSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some(part => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "path must be a normalized relative POSIX path" });
  }
  if (value.normalize("NFC") !== value) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "path must use Unicode NFC" });
  }
});

export const ObsidianConfigurationSchema = z.object({
  vault_id: CaptureIdentifierSchema,
  vault_root: z.string().min(1).max(4_096),
  include: z.tuple([z.literal("**/*.md")]),
  max_file_bytes: z.number().int().min(1).max(8_000_000),
  identity_policy: z.literal(OBSIDIAN_IDENTITY_POLICY),
  parser_contract: z.literal(OBSIDIAN_PARSER_CONTRACT),
  secret_policy: z.literal(OBSIDIAN_SECRET_POLICY),
}).strict();

export const ObsidianFileRevisionSchema = z.object({
  sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
  mtime_ms: z.number().int().nonnegative(),
  file_resource_id: z.string().min(1).max(512).optional(),
}).strict();

const ObsidianUpsertPayloadSchema = z.object({
  version: z.literal(1),
  operation: z.literal("upsert"),
  vault_id: CaptureIdentifierSchema,
  document_id: CaptureIdentifierSchema,
  relative_path: ObsidianSafeRelativePathSchema,
  observed_at: CaptureTimestampSchema,
  revision: ObsidianFileRevisionSchema,
  encoding: z.literal("utf-8"),
  markdown: z.string().max(8_000_000),
}).strict();

const ObsidianDeletePayloadSchema = z.object({
  version: z.literal(1),
  operation: z.literal("delete"),
  vault_id: CaptureIdentifierSchema,
  document_id: CaptureIdentifierSchema,
  relative_path: ObsidianSafeRelativePathSchema,
  observed_at: CaptureTimestampSchema,
  prior_sha256: Sha256Schema,
}).strict();

export const ObsidianSourcePayloadSchema = z.discriminatedUnion("operation", [
  ObsidianUpsertPayloadSchema,
  ObsidianDeletePayloadSchema,
]);

export const ObsidianFrontmatterSchema = z.object({
  raw: z.string(),
  value: JsonValueSchema,
}).strict();

export const ObsidianHeadingSchema = z.object({
  depth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]),
  text: z.string(),
  slug: z.string(),
}).strict();

export const ObsidianLinkDescriptorSchema = z.object({
  syntax: z.enum(["markdown", "wikilink", "embed"]),
  target: z.string().min(1),
  alias: z.string().min(1).optional(),
  heading: z.string().min(1).optional(),
  block_id: z.string().min(1).optional(),
  media_dimensions: z.string().regex(/^\d+(?:x\d+)?$/).optional(),
}).strict();

export const ObsidianDocumentRepresentationSchema = z.object({
  vault_id: CaptureIdentifierSchema,
  document_id: CaptureIdentifierSchema,
  relative_path: ObsidianSafeRelativePathSchema,
  revision: ObsidianFileRevisionSchema.omit({ file_resource_id: true }),
  markdown: z.string().max(8_000_000),
  frontmatter: ObsidianFrontmatterSchema.nullable(),
  headings: z.array(ObsidianHeadingSchema),
  links: z.array(ObsidianLinkDescriptorSchema),
}).strict();

export const ObsidianIdentityEntrySchema = z.object({
  document_id: CaptureIdentifierSchema,
  current_relative_path: ObsidianSafeRelativePathSchema,
  prior_paths: z.array(ObsidianSafeRelativePathSchema).max(OBSIDIAN_MAX_PRIOR_PATHS),
  file_resource_id: z.string().min(1).max(512).optional(),
  last_sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
  mtime_ms: z.number().int().nonnegative(),
}).strict();

const WatcherSnapshotReferenceSchema = z.object({
  path: z.string().regex(/^snapshot-\d+\.bin$/),
  sha256: Sha256Schema,
}).strict();

export const ObsidianCursorSchema = z.object({
  version: z.literal(1),
  vault_id: CaptureIdentifierSchema,
  parser_contract: z.literal(OBSIDIAN_PARSER_CONTRACT),
  root_device: z.string().min(1).max(120),
  root_resource_id: z.string().min(1).max(512),
  logical_manifest_sha256: Sha256Schema,
  documents: z.record(CaptureIdentifierSchema, ObsidianIdentityEntrySchema),
  retired_paths: z.record(ObsidianSafeRelativePathSchema, CaptureIdentifierSchema),
  watcher_snapshot: WatcherSnapshotReferenceSchema.nullable(),
}).strict().superRefine((value, context) => {
  const entries = Object.entries(value.documents);
  if (entries.length + Object.keys(value.retired_paths).length > OBSIDIAN_MAX_DOCUMENTS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["documents"], message: `cursor exceeds ${OBSIDIAN_MAX_DOCUMENTS} active and retired documents` });
  }
  const currentPaths = new Set<string>();
  for (const [key, entry] of entries) {
    if (key !== entry.document_id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["documents", key, "document_id"], message: "document key must match document_id" });
    }
    const normalized = entry.current_relative_path.normalize("NFC");
    if (currentPaths.has(normalized)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["documents", key, "current_relative_path"], message: "current paths must be unique" });
    }
    currentPaths.add(normalized);
  }
});

export type ObsidianConfiguration = z.infer<typeof ObsidianConfigurationSchema>;
export type ObsidianSourcePayload = z.infer<typeof ObsidianSourcePayloadSchema>;
export type ObsidianDocumentRepresentation = z.infer<typeof ObsidianDocumentRepresentationSchema>;
export type ObsidianLinkDescriptor = z.infer<typeof ObsidianLinkDescriptorSchema>;
export type ObsidianCursor = z.infer<typeof ObsidianCursorSchema>;
export type ObsidianIdentityEntry = z.infer<typeof ObsidianIdentityEntrySchema>;
