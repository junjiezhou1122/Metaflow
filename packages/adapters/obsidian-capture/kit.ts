import { createHash } from "node:crypto";
import { defineConnectorKit, type SourceConnection } from "@info/capture";
import {
  OBSIDIAN_CONNECTOR_ID,
  OBSIDIAN_CONNECTOR_VERSION,
  OBSIDIAN_PARSER_CONTRACT,
  OBSIDIAN_SECRET_POLICY,
  ObsidianConfigurationSchema,
  ObsidianSourcePayloadSchema,
  type ObsidianConfiguration,
} from "./contracts.js";
import { parseObsidianMarkdown } from "./parser.js";

export const OBSIDIAN_CONNECTOR_KIT = defineConnectorKit({
  manifest: {
    id: OBSIDIAN_CONNECTOR_ID,
    version: OBSIDIAN_CONNECTOR_VERSION,
    display_name: "Obsidian vault",
    protocols: ["filesystem"],
    capabilities: ["markdown", "logical_manifest", "stable_identity", "source_tombstone"],
    delivery_kinds: ["pull"],
    emitted_schemas: [{ name: "capture.obsidian.document", version: 1, mode: "freeform" }],
  },
  configuration_schema: ObsidianConfigurationSchema,
  payload_schema: ObsidianSourcePayloadSchema,
  adapt(payload, context) {
    const source = context.stableSource({
      source_id: `obsidian-document:${payload.vault_id}:${payload.document_id}`,
      source_kind: "obsidian_document",
    });
    if (payload.operation === "delete") {
      return [{
        idempotency_key: digestKey(context.connection.id, payload.document_id, "delete", payload.prior_sha256),
        name: `Deleted Obsidian document ${payload.document_id.slice(0, 12)}`,
        purpose: "Preserve one exact Obsidian Markdown document revision with deterministic structural descriptors",
        schema: { name: "capture.obsidian.document", version: 1, mode: "freeform" },
        observed_at: payload.observed_at,
        source,
        representation: {
          form: "inline",
          kind: "metaflow.source_tombstone",
          value: { source_deleted: true, reason: "source_deleted", changed_at: payload.observed_at },
          metadata: {},
        },
        metadata: {
          parser_contract: OBSIDIAN_PARSER_CONTRACT,
          secret_policy: OBSIDIAN_SECRET_POLICY,
          relative_path: payload.relative_path,
        },
      }];
    }
    const parsed = parseObsidianMarkdown(payload.markdown);
    const representation = {
      vault_id: payload.vault_id,
      document_id: payload.document_id,
      relative_path: payload.relative_path,
      revision: {
        sha256: payload.revision.sha256,
        byte_length: payload.revision.byte_length,
        mtime_ms: payload.revision.mtime_ms,
      },
      markdown: payload.markdown,
      frontmatter: parsed.frontmatter,
      headings: parsed.headings,
      links: parsed.links,
    };
    return [{
      idempotency_key: digestKey(
        context.connection.id,
        payload.document_id,
        payload.revision.sha256,
        payload.revision.file_resource_id ?? "resource-unavailable",
        payload.relative_path,
      ),
      name: parsed.frontmatter && typeof parsed.frontmatter.value === "object" && !Array.isArray(parsed.frontmatter.value)
        && parsed.frontmatter.value && typeof parsed.frontmatter.value.title === "string"
        ? parsed.frontmatter.value.title
        : payload.relative_path,
      purpose: "Preserve one exact Obsidian Markdown document revision with deterministic structural descriptors",
      aliases: frontmatterAliases(parsed.frontmatter?.value),
      schema: { name: "capture.obsidian.document", version: 1, mode: "freeform" },
      observed_at: payload.observed_at,
      source,
      representation: {
        form: "inline",
        kind: "obsidian_markdown_document",
        value: representation,
        media_type: "text/markdown; charset=utf-8",
        metadata: {},
      },
      relations: [],
      metadata: {
        parser_contract: OBSIDIAN_PARSER_CONTRACT,
        secret_policy: OBSIDIAN_SECRET_POLICY,
      },
    }];
  },
});

export function obsidianSourceConnection(input: {
  id?: string;
  display_name?: string;
  configuration: ObsidianConfiguration;
  privacy?: SourceConnection["privacy"];
  enabled?: boolean;
}): SourceConnection {
  return OBSIDIAN_CONNECTOR_KIT.createConnection({
    id: input.id ?? `obsidian:${input.configuration.vault_id}`,
    display_name: input.display_name ?? "Obsidian vault",
    enabled: input.enabled,
    delivery_kinds: ["pull"],
    configuration: input.configuration,
    privacy: input.privacy,
  });
}

function digestKey(...parts: string[]): string {
  return `obsidian:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function frontmatterAliases(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("aliases" in value)) return [];
  const aliases = (value as { aliases?: unknown }).aliases;
  if (typeof aliases === "string" && aliases.trim()) return [aliases.trim()];
  if (!Array.isArray(aliases)) return [];
  return aliases.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map(item => item.trim())
    .slice(0, 100);
}
