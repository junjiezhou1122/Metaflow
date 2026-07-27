import { Worker } from "node:worker_threads";
import { z } from "zod";
import { OperatorExecutionFailure } from "@info/execution";
import { type JsonObject, type ViewRepresentation } from "@info/view";
import {
  MARKDOWN_PARSER_REF,
  ParserInvocationSchema,
  ParserResultSchema,
  type ParserInvocation,
  type ParserResult,
  type ViewFragment,
} from "./contracts.js";

const WorkerFragmentSchema = z.object({
  kind: z.enum(["text", "title", "code", "table", "metadata"]),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  text: z.string().min(1),
}).strict().refine(value => value.end >= value.start, { message: "worker fragment end precedes start" });

const WorkerMessageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded"), fragments: z.array(WorkerFragmentSchema).max(4_096) }).strict(),
  z.object({
    status: z.literal("failed"),
    code: z.string().trim().min(1).max(240),
    message: z.string().trim().min(1).max(2_000),
    details: z.record(z.union([z.null(), z.boolean(), z.number().finite(), z.string()])),
  }).strict(),
]);

export type MarkdownParseOptions = {
  signal?: AbortSignal;
  timeout_ms?: number;
};

export async function parseMarkdownView(input: unknown, options: MarkdownParseOptions = {}): Promise<ParserResult> {
  const parsedInvocation = ParserInvocationSchema.safeParse(input);
  if (!parsedInvocation.success) {
    throw new OperatorExecutionFailure(
      "parser_invocation_invalid",
      "Markdown Parser invocation does not satisfy the exact Parser ABI",
      { issue_count: parsedInvocation.error.issues.length },
      { cause: parsedInvocation.error },
    );
  }
  const invocation = parsedInvocation.data;
  assertMarkdownParser(invocation);
  const source = extractMarkdown(invocation.input.representation);
  const inputBytes = Buffer.byteLength(source.markdown, "utf8");
  if (inputBytes > invocation.limits.max_input_bytes) {
    throw new OperatorExecutionFailure(
      "parser_input_too_large",
      `Markdown input exceeds ${invocation.limits.max_input_bytes} bytes`,
      { input_bytes: inputBytes, max_input_bytes: invocation.limits.max_input_bytes },
    );
  }

  const workerFragments = await parseInWorker(source.markdown, invocation, options);
  const fragments: ViewFragment[] = workerFragments.map(fragment => ({
    contract_version: 1,
    kind: fragment.kind,
    location: {
      kind: "text_range",
      path: source.path,
      start: fragment.start,
      length: fragment.end - fragment.start,
    },
    content: { kind: "text", text: fragment.text },
    metadata: {},
  }));

  return ParserResultSchema.parse({
    contract_version: 1,
    source: invocation.input.ref,
    fragments,
    diagnostics: { parser: MARKDOWN_PARSER_REF, warnings: [] },
  });
}

function assertMarkdownParser(invocation: ParserInvocation): void {
  const parser = invocation.parser;
  if (
    parser.parser_id !== MARKDOWN_PARSER_REF.parser_id
    || parser.version !== MARKDOWN_PARSER_REF.version
    || parser.abi_version !== MARKDOWN_PARSER_REF.abi_version
  ) {
    throw new OperatorExecutionFailure("parser_contract_mismatch", "Markdown parser reference is not supported", {
      parser_id: parser.parser_id,
      version: parser.version,
      abi_version: parser.abi_version,
    });
  }
}

function extractMarkdown(representation: ViewRepresentation): { markdown: string; path: string } {
  if (representation.form !== "inline") {
    throw new OperatorExecutionFailure(
      "parser_representation_unsupported",
      "Markdown parser requires an inline Representation; external materialization must be an explicit Transformation",
      { form: representation.form, kind: representation.kind },
    );
  }
  const mediaType = representation.media_type?.split(";", 1)[0]?.trim().toLowerCase();
  const declaresMarkdown = mediaType === undefined
    ? representation.kind.toLowerCase() === "markdown"
    : mediaType === "text/markdown";
  if (!declaresMarkdown) {
    throw new OperatorExecutionFailure("parser_representation_unsupported", "Representation does not declare the exact Markdown profile", {
      form: representation.form,
      kind: representation.kind,
      media_type: representation.media_type ?? null,
    });
  }
  if (typeof representation.value === "string") {
    return { markdown: representation.value, path: "/representation/value" };
  }
  if (
    representation.value !== null
    && !Array.isArray(representation.value)
    && typeof representation.value === "object"
    && typeof representation.value.markdown === "string"
  ) {
    return { markdown: representation.value.markdown, path: "/representation/value/markdown" };
  }
  throw new OperatorExecutionFailure(
    "parser_representation_unsupported",
    "Markdown Representation must be a string or expose one string at /markdown",
    { form: representation.form, kind: representation.kind },
  );
}

async function parseInWorker(
  markdown: string,
  invocation: ParserInvocation,
  options: MarkdownParseOptions,
): Promise<Array<z.infer<typeof WorkerFragmentSchema>>> {
  const timeoutMs = options.timeout_ms;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new OperatorExecutionFailure("parser_timeout_invalid", "Parser timeout must be a positive integer", {
      timeout_ms: timeoutMs,
    });
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("Markdown Parser was cancelled");

  const worker = new Worker(new URL("./parser-worker.mjs", import.meta.url), {
    workerData: {
      markdown,
      limits: {
        max_fragments: invocation.limits.max_fragments,
        max_fragment_bytes: invocation.limits.max_fragment_bytes,
      },
    },
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    type Outcome = { value: Array<z.infer<typeof WorkerFragmentSchema>> } | { error: unknown };
    const finish = (outcome: Outcome) => {
      if ("error" in outcome) reject(outcome.error);
      else resolve(outcome.value);
    };
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
            "Markdown Parser Worker termination failed",
          ),
        }),
      );
    };
    const abort = () => settle({ error: options.signal?.reason ?? new Error("Markdown Parser was cancelled") }, true);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      settle({
        error: new OperatorExecutionFailure(
          "parser_timeout",
          `Markdown Parser exceeded ${timeoutMs} milliseconds`,
          { timeout_ms: timeoutMs },
        ),
      }, true);
    }, timeoutMs);

    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", raw => {
      const message = WorkerMessageSchema.safeParse(raw);
      if (!message.success) {
        settle({ error: new Error("Markdown Parser Worker returned an invalid result", { cause: message.error }) });
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
    worker.once("error", error => settle({ error: new Error("Markdown Parser Worker crashed", { cause: error }) }));
    worker.once("exit", code => {
      if (code !== 0 && !settled) settle({ error: new Error(`Markdown Parser Worker exited with code ${code}`) });
    });
  });
}
