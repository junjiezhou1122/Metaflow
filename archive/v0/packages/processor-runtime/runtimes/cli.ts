import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessorContext, ProcessorHandlerResult, ProcessorInput } from "../types.js";
import { parseProcessorHandlerResult, processorRuntimePayload } from "./result.js";

const execFileAsync = promisify(execFile);

export async function runCliProcessor(
  input: ProcessorInput,
  context: ProcessorContext,
): Promise<ProcessorHandlerResult> {
  const runtime = context.processor.runtime;
  if (runtime.kind !== "cli") throw new Error(`CLI processor runtime expected cli config: ${context.processor.id}`);
  const payload = processorRuntimePayload(input, context.processor);
  const { stdout } = await execFileAsync(runtime.command, runtime.args ?? [], {
    env: {
      ...process.env,
      INFO_PROCESSOR_INPUT: JSON.stringify(payload),
      INFO_PROCESSOR_ID: context.processor.id,
      INFO_PROCESSOR_RUNTIME: "cli",
    },
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseProcessorHandlerResult(JSON.parse(stdout), `cli processor ${context.processor.id}`);
}
