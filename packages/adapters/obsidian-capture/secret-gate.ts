import { createEngine } from "@secretlint/node";
import { createHash } from "node:crypto";
import { CaptureRuntimeError } from "@info/capture";
import { z } from "zod";
import { OBSIDIAN_SECRET_POLICY, type ObsidianDocumentRepresentation } from "./contracts.js";

const SecretlintOutputSchema = z.array(z.object({
  messages: z.array(z.object({
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    ruleId: z.string().min(1),
  }).passthrough()),
}).passthrough());

const FORBIDDEN_KEY = /^(?:password|passphrase|token|access_token|refresh_token|api_key|apikey|secret|client_secret|private_key|credential|credentials)$/i;
const FORBIDDEN_QUERY_KEY = /^(?:token|access_token|refresh_token|api_key|apikey|secret|key)$/i;

export interface ObsidianSecretGate {
  assertSafe(input: {
    connection_id: string;
    relative_path: string;
    markdown: string;
    content_sha256: string;
    frontmatter: ObsidianDocumentRepresentation["frontmatter"];
  }): Promise<void>;
}

export class SecretlintObsidianSecretGate implements ObsidianSecretGate {
  private engine: ReturnType<typeof createEngine> | undefined;

  async assertSafe(input: Parameters<ObsidianSecretGate["assertSafe"]>[0]): Promise<void> {
    if (input.markdown.includes("secretlint-disable")) {
      throw secretMatch(input, input.markdown.indexOf("secretlint-disable"), "obsidian/no-secretlint-suppression");
    }
    const engine = await this.getEngine();
    let result: Awaited<ReturnType<Awaited<ReturnType<typeof createEngine>>["executeOnContent"]>>;
    try {
      result = await engine.executeOnContent({ content: input.markdown, filePath: input.relative_path });
    } catch (error) {
      throw scannerFailure(input, error);
    }
    if (!result.ok) {
      let output: unknown;
      try {
        output = JSON.parse(result.output) as unknown;
      } catch (error) {
        throw scannerFailure(input, error);
      }
      const parsed = SecretlintOutputSchema.safeParse(output);
      if (!parsed.success || !parsed.data[0]?.messages[0]) throw scannerFailure(input);
      const match = parsed.data[0].messages[0];
      throw secretMatch(input, match.range[0], match.ruleId);
    }
    const structural = findStructuralSecret(input.frontmatter?.value, input.markdown);
    if (structural) throw secretMatch(input, structural.byte_offset, structural.rule_id);
  }

  private async getEngine(): Promise<Awaited<ReturnType<typeof createEngine>>> {
    try {
      this.engine ??= createEngine({
        formatter: "json",
        color: false,
        terminalLink: false,
        maskSecrets: true,
        configFileJSON: { rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }] },
      });
      return await this.engine;
    } catch (error) {
      throw new CaptureRuntimeError(
        "Obsidian secret scanner initialization failed",
        "obsidian_secret_scanner_failed",
        "connector",
        false,
        { policy_version: OBSIDIAN_SECRET_POLICY },
        { cause: error },
      );
    }
  }
}

function findStructuralSecret(value: unknown, markdown: string): { byte_offset: number; rule_id: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findStructuralSecret(item, markdown);
      if (result) return result;
    }
    return undefined;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(key)) {
      return { byte_offset: characterOffset(markdown, key), rule_id: "obsidian/frontmatter-secret-key" };
    }
    if (typeof nested === "string") {
      try {
        const url = new URL(nested);
        if (url.username || url.password || [...url.searchParams.keys()].some(parameter => FORBIDDEN_QUERY_KEY.test(parameter))) {
          return { byte_offset: characterOffset(markdown, nested), rule_id: "obsidian/frontmatter-credential-url" };
        }
      } catch {
        // Non-URL strings remain eligible for recursive scanner rules only.
      }
    }
    const result = findStructuralSecret(nested, markdown);
    if (result) return result;
  }
  return undefined;
}

function characterOffset(markdown: string, value: string): number {
  return Math.max(0, markdown.indexOf(value));
}

function secretMatch(
  input: Parameters<ObsidianSecretGate["assertSafe"]>[0],
  characterOffset: number,
  ruleId: string,
): CaptureRuntimeError {
  const byteOffsetValue = Buffer.byteLength(input.markdown.slice(0, Math.max(0, characterOffset)), "utf8");
  return new CaptureRuntimeError(
    "Obsidian document was blocked by the pre-batch secret policy",
    "obsidian_secret_detected",
    "connector",
    false,
    {
      connection_id: input.connection_id,
      relative_path: input.relative_path,
      byte_offset: byteOffsetValue,
      content_sha256: input.content_sha256,
      rule_id: ruleId,
      policy_version: OBSIDIAN_SECRET_POLICY,
    },
  );
}

function scannerFailure(input: Parameters<ObsidianSecretGate["assertSafe"]>[0], cause?: unknown): CaptureRuntimeError {
  return new CaptureRuntimeError(
    "Obsidian secret scanner returned an incompatible result",
    "obsidian_secret_scanner_failed",
    "connector",
    false,
    {
      connection_id: input.connection_id,
      relative_path: input.relative_path,
      content_sha256: input.content_sha256 || createHash("sha256").update(input.markdown).digest("hex"),
      policy_version: OBSIDIAN_SECRET_POLICY,
    },
    cause ? { cause } : undefined,
  );
}
