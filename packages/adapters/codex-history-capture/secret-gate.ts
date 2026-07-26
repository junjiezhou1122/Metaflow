import { lintSource } from "@secretlint/core";
import { creator as recommendedPreset } from "@secretlint/secretlint-rule-preset-recommend";
import { CaptureRuntimeError } from "@info/capture";
import { z } from "zod";
import { CODEX_SECRET_POLICY } from "./contracts.js";

export type CodexContentInspection = {
  rule_ids: string[];
};

export interface CodexContentGate {
  inspect(texts: readonly string[]): Promise<CodexContentInspection>;
}

const CodexContentInspectionSchema = z.object({
  rule_ids: z.array(z.string().min(1).max(200).regex(/^@?[-a-zA-Z0-9_./]+$/)).max(64),
}).strict().superRefine((value, context) => {
  if (new Set(value.rule_ids).size !== value.rule_ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["rule_ids"], message: "Rule ids must be unique" });
  }
});

export class SecretlintRecommendedContentGate implements CodexContentGate {
  async inspect(texts: readonly string[]): Promise<CodexContentInspection> {
    const ruleIds = new Set<string>();
    for (const text of texts) {
      const result = await lintSource({
        source: {
          filePath: "codex-safe-record.txt",
          content: text,
          ext: ".txt",
          contentType: "text",
        },
        options: {
          maskSecrets: true,
          noPhysicFilePath: true,
          config: {
            rules: [{
              id: "@secretlint/secretlint-rule-preset-recommend",
              rule: recommendedPreset,
              options: {},
            }],
          },
        },
      });
      for (const message of result.messages) ruleIds.add(message.ruleId);
    }
    return { rule_ids: [...ruleIds].sort() };
  }
}

export async function assertCodexContentSafe(input: {
  gate: CodexContentGate;
  texts: readonly string[];
  session_id: string;
  byte_offset: number;
  record_sha256: string;
}): Promise<void> {
  let inspection: CodexContentInspection;
  try {
    inspection = CodexContentInspectionSchema.parse(await input.gate.inspect(input.texts));
  } catch {
    throw new CaptureRuntimeError(
      "Codex content scanner failed before batch formation",
      "codex_secret_scanner_failed",
      "connector",
      false,
      {
        session_id: input.session_id,
        byte_offset: input.byte_offset,
        record_sha256: input.record_sha256,
        policy_version: CODEX_SECRET_POLICY,
      },
    );
  }
  if (inspection.rule_ids.length === 0) return;
  throw new CaptureRuntimeError(
    "Codex content was rejected before batch formation",
    "codex_secret_detected",
    "connector",
    false,
    {
      session_id: input.session_id,
      byte_offset: input.byte_offset,
      record_sha256: input.record_sha256,
      rule_ids: inspection.rule_ids,
      policy_version: CODEX_SECRET_POLICY,
    },
  );
}
