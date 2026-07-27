import { Worker } from "node:worker_threads";
import { z } from "zod";
import { OperatorExecutionFailure } from "@info/execution";
import { canonicalJson, type JsonObject } from "@info/view";
import {
  STRUCTURED_PARSER_REFS,
  StructuredParserInvocationSchema,
  StructuredParserResultSchema,
  StructuredViewFragmentSchema,
  structuredParserKind,
  type StructuredParserInvocation,
  type StructuredParserLimits,
  type StructuredParserResult,
  type StructuredViewFragment,
} from "./contracts.js";

const WorkerMessageSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("succeeded"),
    fragments: z.array(StructuredViewFragmentSchema.omit({ contract_version: true })).max(4_096),
  }).strict(),
  z.object({
    status: z.literal("failed"),
    code: z.string().trim().min(1).max(240),
    message: z.string().trim().min(1).max(2_000),
    details: z.record(z.union([z.null(), z.boolean(), z.number().finite(), z.string()])),
  }).strict(),
]);

export type StructuredParseOptions = {
  signal?: AbortSignal;
  timeout_ms?: number;
  worker_url?: URL;
};

export async function parseStructuredView(
  input: unknown,
  options: StructuredParseOptions = {},
): Promise<StructuredParserResult> {
  const parsed = StructuredParserInvocationSchema.safeParse(input);
  if (!parsed.success) {
    throw new OperatorExecutionFailure(
      "parser_invocation_invalid",
      "Structured Parser invocation does not satisfy the exact Parser ABI",
      { issue_count: parsed.error.issues.length },
      { cause: parsed.error },
    );
  }
  const invocation = parsed.data;
  assertRepresentation(invocation);
  const inputBytes = Buffer.byteLength(canonicalJson({
    representation: invocation.input.representation,
    materialization: invocation.input.materialization,
  }), "utf8");
  if (inputBytes > invocation.limits.max_input_bytes) {
    throw new OperatorExecutionFailure(
      "parser_input_too_large",
      `Structured Parser input exceeds ${invocation.limits.max_input_bytes} bytes`,
      { input_bytes: inputBytes, max_input_bytes: invocation.limits.max_input_bytes },
    );
  }

  const workerFragments = await parseInWorker(invocation, options);
  assertConfiguredOutputBounds(workerFragments, invocation.limits);
  const fragments: StructuredViewFragment[] = workerFragments.map(fragment => ({
    contract_version: 2,
    ...fragment,
  }));
  const result = StructuredParserResultSchema.safeParse({
    contract_version: 2,
    source: invocation.input.ref,
    fragments,
    diagnostics: { parser: invocation.parser, warnings: [] },
  });
  if (!result.success) {
    throw new OperatorExecutionFailure(
      "parser_result_malformed",
      "Structured Parser result does not satisfy fragment-set ABI v2",
      { issue_count: result.error.issues.length },
      { cause: result.error },
    );
  }
  return result.data;
}

function assertConfiguredOutputBounds(
  fragments: Array<Omit<StructuredViewFragment, "contract_version">>,
  limits: StructuredParserLimits,
): void {
  if (fragments.length > limits.max_fragments) {
    throw new OperatorExecutionFailure(
      "parser_result_malformed",
      "Structured Parser Worker exceeded the frozen fragment count",
      { fragment_count: fragments.length, max_fragments: limits.max_fragments },
    );
  }
  const oversized = fragments.findIndex(fragment =>
    Buffer.byteLength(fragment.content.text, "utf8") > limits.max_fragment_bytes);
  if (oversized < 0) return;
  throw new OperatorExecutionFailure(
    "parser_result_malformed",
    "Structured Parser Worker exceeded the frozen fragment byte bound",
    { fragment_index: oversized, max_fragment_bytes: limits.max_fragment_bytes },
  );
}

function assertRepresentation(invocation: StructuredParserInvocation): void {
  const representation = invocation.input.representation;
  const kind = structuredParserKind(invocation.parser);
  if (kind === "external_reference") {
    if (representation.form !== "external_reference" || representation.kind !== "external_resource") {
      throw unsupported(invocation);
    }
    const materializations = [
      invocation.input.materialization.primary,
      ...invocation.input.materialization.alternatives,
    ];
    const matching = materializations.find(materialization =>
      materialization.location.kind === "uri" && materialization.location.uri === representation.uri);
    if (!matching) {
      throw new OperatorExecutionFailure(
        "parser_materialization_missing",
        "External-reference Parser requires a committed URI materialization matching the frozen reference",
        { parser_id: invocation.parser.parser_id, representation_uri: representation.uri },
      );
    }
    return;
  }
  const expectedKind = {
    json: "json_document",
    table: "data_table",
    graph: "property_graph",
  }[kind];
  const mediaType = representation.media_type?.split(";", 1)[0]?.trim().toLowerCase();
  if (representation.form !== "inline" || representation.kind !== expectedKind || mediaType !== "application/json") {
    throw unsupported(invocation);
  }
}

function unsupported(invocation: StructuredParserInvocation): OperatorExecutionFailure {
  return new OperatorExecutionFailure(
    "parser_representation_unsupported",
    "Representation does not match the frozen structured Parser profile",
    {
      parser_id: invocation.parser.parser_id,
      form: invocation.input.representation.form,
      representation_kind: invocation.input.representation.kind,
      media_type: invocation.input.representation.media_type ?? null,
    },
  );
}

async function parseInWorker(
  invocation: StructuredParserInvocation,
  options: StructuredParseOptions,
): Promise<Array<Omit<StructuredViewFragment, "contract_version">>> {
  const timeoutMs = options.timeout_ms;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new OperatorExecutionFailure("parser_timeout_invalid", "Parser timeout must be a positive integer", {
      timeout_ms: timeoutMs,
    });
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Structured Parser was cancelled");

  const worker = new Worker(options.worker_url ?? new URL("./parser-worker.mjs", import.meta.url), {
    workerData: {
      parser_id: invocation.parser.parser_id,
      representation: invocation.input.representation,
      limits: invocation.limits,
    },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    type Fragments = Array<Omit<StructuredViewFragment, "contract_version">>;
    type Outcome = { value: Fragments } | { error: unknown };
    const finish = (outcome: Outcome) => "error" in outcome ? reject(outcome.error) : resolve(outcome.value);
    const settle = (outcome: Outcome, terminate = false) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (!terminate) {
        finish(outcome);
        return;
      }
      void worker.terminate().then(
        () => finish(outcome),
        terminationError => finish({
          error: new AggregateError(
            ["error" in outcome ? outcome.error : new Error("Parser completed before termination"), terminationError],
            "Structured Parser Worker termination failed",
          ),
        }),
      );
    };
    const abort = () => settle({ error: options.signal?.reason ?? new Error("Structured Parser was cancelled") }, true);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      settle({
        error: new OperatorExecutionFailure(
          "parser_timeout",
          `Structured Parser exceeded ${timeoutMs} milliseconds`,
          { timeout_ms: timeoutMs },
        ),
      }, true);
    }, timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", raw => {
      const message = WorkerMessageSchema.safeParse(raw);
      if (!message.success) {
        settle({
          error: new OperatorExecutionFailure(
            "parser_result_malformed",
            "Structured Parser Worker returned a malformed result",
            { issue_count: message.error.issues.length },
            { cause: message.error },
          ),
        });
        return;
      }
      if (message.data.status === "failed") {
        settle({
          error: new OperatorExecutionFailure(
            message.data.code,
            message.data.message,
            message.data.details as JsonObject,
          ),
        });
        return;
      }
      settle({ value: message.data.fragments });
    });
    worker.once("error", cause => settle({
      error: new OperatorExecutionFailure(
        "parser_implementation_crash",
        "Structured Parser Worker crashed",
        { parser_id: invocation.parser.parser_id },
        { cause },
      ),
    }));
    worker.once("exit", code => {
      if (code !== 0 && !settled) {
        settle({
          error: new OperatorExecutionFailure(
            "parser_implementation_crash",
            `Structured Parser Worker exited with code ${code}`,
            { parser_id: invocation.parser.parser_id, exit_code: code },
          ),
        });
      }
    });
  });
}

export function structuredParserRefForId(parserId: string) {
  return Object.values(STRUCTURED_PARSER_REFS).find(ref => ref.parser_id === parserId);
}
